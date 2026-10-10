import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConnectOptions, ConnectResult } from '../../daemon-client/connect-or-spawn';
import type { ClientStatus, DaemonClient } from '../../daemon-client/daemon-client';
import { openHostConnection, type HostConnectionDeps } from '../../host/host-connection';
import { defaultHostConfig } from '../../host/host-config';
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
const notices = { info: noop, warn: noop, shellNoise: noop };

function fakeClient(): DaemonClient & { closed: number } {
  const c = {
    closed: 0, loginRecipes: [],
    post: noop, onMessage: () => noop, onStatus: () => noop, pushContext: noop,
    close: () => { c.closed++; },
  };
  return c as unknown as DaemonClient & { closed: number };
}

suite('host connection', () => {
  let dir: string;
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mar-hc-')); });
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const config = (daemon = true) => ({
    ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined },
    daemon: { enabled: daemon, idleMinutes: 10 },
  });
  const deps = (over: Partial<HostConnectionDeps> = {}): HostConnectionDeps => ({
    workspaceDir: dir, config: config(), roots: () => [dir], defaultCwd: dir, configSignature: 'sig',
    hooks, notices, showCacheTimer: false, favoriteModels: () => [], context: () => null,
    spawn: async () => {}, ...over,
  });

  test('attached: daemon mode, later surfaces connect without the first-attach policies', async () => {
    const calls: ConnectOptions[] = [];
    const clients: Array<DaemonClient & { closed: number }> = [];
    const conn = await openHostConnection(deps({
      connectOrSpawn: async (o): Promise<ConnectResult> => {
        calls.push(o);
        const client = fakeClient();
        clients.push(client);
        return { kind: 'attached', client };
      },
    }));
    assert.strictEqual(conn.mode, 'daemon');
    assert.strictEqual(conn.fallbackNotice === undefined, true);
    assert.strictEqual(calls[0].clientKind, 'sidebar');
    assert.strictEqual(calls[0].configSignature, 'sig');
    assert.strictEqual(calls[0].replaceOlderBuild, true);

    const sidebar = await conn.connect('sidebar');
    assert.strictEqual(calls.length, 1);
    await conn.connect('review');
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1].clientKind, 'review');
    assert.strictEqual(calls[1].configSignature === undefined, true);
    assert.strictEqual(calls[1].replaceOlderBuild === undefined, true);

    await conn.dispose();
    assert.deepStrictEqual(clients.map((c) => c.closed), [1, 1]);
    sidebar.dispose();
    assert.strictEqual(clients[0].closed, 1);
  });

  test('a fallback runs the host in-process and says why', async () => {
    const conn = await openHostConnection(deps({
      connectOrSpawn: async (): Promise<ConnectResult> => ({ kind: 'fallback', reason: 'newer-daemon', message: 'x' }),
    }));
    try {
      assert.strictEqual(conn.mode, 'in-process');
      assert.strictEqual(conn.fallbackNotice, 'Running without the background host: x');
      const link = await conn.connect('sidebar');
      const got: HostToWebview[] = [];
      link.transport.onMessage((m) => got.push(m));
      link.transport.post({ t: 'ready' });
      for (let i = 0; i < 100 && !got.some((m) => m.t === 'hydrate'); i++) { await new Promise((r) => setTimeout(r, 10)); }
      assert.strictEqual(got.some((m) => m.t === 'hydrate'), true);
    } finally {
      await conn.dispose();
    }
  });

  test('daemon.enabled = false never asks for a daemon and says nothing', async () => {
    let asked = 0;
    const conn = await openHostConnection(deps({
      config: config(false),
      connectOrSpawn: async (): Promise<ConnectResult> => { asked++; return { kind: 'fallback', reason: 'disabled', message: '' }; },
    }));
    try {
      assert.strictEqual(conn.mode, 'in-process');
      assert.strictEqual(asked, 0);
      assert.strictEqual(conn.fallbackNotice === undefined, true);
    } finally {
      await conn.dispose();
    }
  });

  test('a surface that cannot reach the daemon gets a link that reports lost, never a rejection', async () => {
    let n = 0;
    const conn = await openHostConnection(deps({
      connectOrSpawn: async (): Promise<ConnectResult> => (n++ === 0
        ? { kind: 'attached', client: fakeClient() }
        : { kind: 'fallback', reason: 'spawn-failed', message: 'gone' }),
    }));
    const link = await conn.connect('fleet');
    const seen: ClientStatus[] = [];
    link.onStatus((s) => seen.push(s));
    await new Promise((r) => setTimeout(r, 5));
    assert.deepStrictEqual(seen, ['lost']);
    await conn.dispose();
  });

  test('in-process links are gated by surface kind', async () => {
    const conn = await openHostConnection(deps({ config: config(false) }));
    try {
      const sidebar = await conn.connect('sidebar');
      const review = await conn.connect('review');
      const sidebarGot: HostToWebview[] = [];
      const reviewGot: HostToWebview[] = [];
      sidebar.transport.onMessage((m) => sidebarGot.push(m));
      review.transport.onMessage((m) => reviewGot.push(m));
      const until = async (cond: () => boolean) => {
        for (let i = 0; i < 200 && !cond(); i++) { await new Promise((r) => setTimeout(r, 10)); }
      };
      sidebar.transport.post({ t: 'ready' });
      review.transport.post({ t: 'ready' });
      sidebar.transport.post({ t: 'create-session', providerId: 'fake', cwd: dir } as never);
      await until(() => sidebarGot.some((m) => m.t === 'session-snapshot'));
      const snap = sidebarGot.find((m) => m.t === 'session-snapshot') as Extract<HostToWebview, { t: 'session-snapshot' }>;
      sidebar.transport.post({ t: 'set-visible', sessionIds: [snap.session.id] });
      sidebar.transport.post({ t: 'send', id: snap.session.id, text: 'hi' } as never);
      await until(() => sidebarGot.some((m) => m.t === 'session-patch'));
      assert.strictEqual(sidebarGot.some((m) => m.t === 'session-patch'), true);
      assert.strictEqual(reviewGot.some((m) => m.t === 'sessions-changed'), true);
      assert.strictEqual(reviewGot.some((m) => m.t === 'session-patch'), false);
    } finally {
      await conn.dispose();
    }
  });
});
