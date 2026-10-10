import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDaemon, type RunningDaemon } from '../../daemon/run-daemon';
import { openHostConnection, type HostConnectionDeps } from '../../host/host-connection';
import { defaultHostConfig } from '../../host/host-config';
import type { HostConnection, SurfaceLink } from '../../host/surface-link';
import type { HostToWebview, ShellItem } from '../../protocol/messages';

const noop = () => {};
const hooks = {
  editor: {
    current: () => null, reveal: noop, openDiff: noop, openSettings: noop, openExternal: noop,
    exportCsv: noop, exportImage: noop, login: noop,
  },
  picker: { pick: async () => [] },
  fileSearch: { search: async () => [] },
  configHost: { setFavoriteModels: noop },
  updateNotify: { notify: noop },
};

const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) { await new Promise((r) => setTimeout(r, 10)); }
};

function collect(link: SurfaceLink): HostToWebview[] {
  const got: HostToWebview[] = [];
  link.transport.onMessage((m) => got.push(m));
  return got;
}

const shellItems = (got: HostToWebview[]): ShellItem[] => got.flatMap((m) =>
  m.t === 'session-patch' && 'item' in m.patch && m.patch.item.role === 'shell' ? [m.patch.item] : []);

suite('shell commands over the daemon', function () {
  this.timeout(30000);
  let dir: string;
  let daemon: RunningDaemon;
  const connections: HostConnection[] = [];
  const config = {
    ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined },
    shell: { aliases: { node: { command: process.execPath, args: ['-e'] } } },
  };
  const open = async (): Promise<HostConnection> => {
    const deps: HostConnectionDeps = {
      workspaceDir: dir, config, roots: () => [dir], defaultCwd: dir, configSignature: 'sig', hooks,
      notices: { info: noop, warn: noop, shellNoise: noop }, showCacheTimer: false, favoriteModels: () => [],
      context: () => null,
      spawn: async () => { throw new Error('a daemon is already running; nothing should spawn'); },
    };
    const conn = await openHostConnection(deps);
    connections.push(conn);
    return conn;
  };

  setup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mar-shell-d-'));
    daemon = await runDaemon({
      workspaceDir: dir, config, appVersion: '9.9.9', initialRoots: [dir], idleMsOverride: 600_000,
    });
  });
  teardown(async () => {
    for (const c of connections.splice(0)) { await c.dispose(); }
    await daemon.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a run started by one client reaches another and survives the first disconnecting', async () => {
    const conn = await open();
    assert.strictEqual(conn.mode, 'daemon', conn.fallbackNotice);
    const a = await conn.connect('sidebar');
    const b = await conn.connect('sidebar');
    const aGot = collect(a);
    const bGot = collect(b);
    a.transport.post({ t: 'ready' });
    b.transport.post({ t: 'ready' });
    await until(() => aGot.some((m) => m.t === 'hydrate') && bGot.some((m) => m.t === 'hydrate'));

    a.transport.post({ t: 'create-session', providerId: 'fake', cwd: dir } as never);
    await until(() => aGot.some((m) => m.t === 'session-snapshot'));
    const snap = aGot.find((m) => m.t === 'session-snapshot') as Extract<HostToWebview, { t: 'session-snapshot' }>;
    const id = snap.session.id;
    a.transport.post({ t: 'set-visible', sessionIds: [id] });
    b.transport.post({ t: 'set-visible', sessionIds: [id] });
    await new Promise((r) => setTimeout(r, 100));

    a.transport.post({ t: 'run-shell', id, command: 'node setTimeout(()=>console.log("late"),300)' });
    await until(() => shellItems(bGot).length > 0);
    a.dispose();
    await until(() => shellItems(bGot).some((i) => i.state === 'done'));
    const last = shellItems(bGot).at(-1)!;
    assert.deepStrictEqual([last.state, last.exitCode, last.output.trim()], ['done', 0, 'late']);
  });
});
