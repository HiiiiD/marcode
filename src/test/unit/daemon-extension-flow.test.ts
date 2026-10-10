import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readDaemonInfo } from '../../daemon/daemon-info';
import { runDaemon, type RunningDaemon } from '../../daemon/run-daemon';
import { openHostConnection, type HostConnectionDeps } from '../../host/host-connection';
import { defaultHostConfig } from '../../host/host-config';
import type { HostConnection, SurfaceLink } from '../../host/surface-link';
import type { HostToWebview } from '../../protocol/messages';

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

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) { await new Promise((r) => setTimeout(r, 10)); }
};

function collect(link: SurfaceLink): HostToWebview[] {
  const got: HostToWebview[] = [];
  link.transport.onMessage((m) => got.push(m));
  return got;
}

suite('extension attaches to the daemon', function () {
  this.timeout(30000);
  let dir: string;
  let daemon: RunningDaemon;
  const connections: HostConnection[] = [];
  const config = {
    ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined },
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mar-ext-'));
    daemon = await runDaemon({
      workspaceDir: dir, config, appVersion: '9.9.9', initialRoots: [dir], idleMsOverride: 600_000,
    });
  });
  teardown(async () => {
    for (const c of connections.splice(0)) { await c.dispose(); }
    await daemon.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a turn parked on an approval survives a window reload', async () => {
    const first = await open();
    assert.strictEqual(first.mode, 'daemon', first.fallbackNotice);
    const sidebar = await first.connect('sidebar');
    const review = await first.connect('review');
    const sidebarGot = collect(sidebar);
    const reviewGot = collect(review);
    sidebar.transport.post({ t: 'ready' });
    review.transport.post({ t: 'ready' });
    await until(() => sidebarGot.some((m) => m.t === 'hydrate') && reviewGot.some((m) => m.t === 'hydrate'));
    assert.strictEqual(reviewGot.some((m) => m.t === 'hydrate'), true);

    sidebar.transport.post({ t: 'create-session', providerId: 'fake', cwd: dir, seed: { text: 'permission fixture' } } as never);
    await until(() => sidebarGot.some((m) => m.t === 'session-snapshot'));
    const snap = sidebarGot.find((m) => m.t === 'session-snapshot') as Extract<HostToWebview, { t: 'session-snapshot' }>;
    sidebar.transport.post({ t: 'set-visible', sessionIds: [snap.session.id] });
    await until(() => sidebarGot.some((m) => m.t === 'session-status' && m.status === 'awaiting-approval'));
    assert.strictEqual(reviewGot.some((m) => m.t === 'session-patch'), false);

    await first.dispose();
    assert.strictEqual((await readDaemonInfo(dir))?.pid, process.pid);

    const second = await open();
    const link = await second.connect('sidebar');
    const got = collect(link);
    link.transport.post({ t: 'ready' });
    await until(() => got.some((m) => m.t === 'hydrate'));
    const hydrate = got.find((m) => m.t === 'hydrate') as Extract<HostToWebview, { t: 'hydrate' }>;
    const restored = hydrate.sessions.find((s) => s.id === snap.session.id);
    assert.strictEqual(restored?.status, 'awaiting-approval');
  });
});
