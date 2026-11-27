import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, setup, teardown, test } from 'mocha';
import { SessionManager } from '../../host/session-manager';
import { SessionOwnership } from '../../host/session-ownership';
import { RemoteSessions } from '../../host/sync/remote-sessions';
import { mirrorStoreDir, SessionMirror } from '../../host/sync/session-mirror';
import { TranscriptStore } from '../../host/transcript-store';
import type { HostToWebview, SessionState, TranscriptItem } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';
import { publishedState } from '../../sync/session-records';

const item = (id: string, text = id): TranscriptItem => ({ id, ts: 0, role: 'assistant', text });
const remoteState = (over: Partial<SessionState> = {}): SessionState => ({
  id: 'r1', providerId: 'fake', model: 'm', title: 'Remote work', name: 'remote', cwd: '/elsewhere/repo', status: 'idle',
  permissionMode: 'default', includeEditorContext: false, resumeTokens: {}, createdAt: 1, updatedAt: 2, projectId: 'github.com/a/b', ...over,
});

async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) { throw new Error(`timed out waiting for ${what}`); }
    await new Promise((r) => setTimeout(r, 10));
  }
}

suite('RemoteSessions in the manager', () => {
  let dir: string;
  let mirrorRoot: string;
  let mirror: SessionMirror;
  const cleanups: Array<() => Promise<void>> = [];

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-remote-'));
    mirrorRoot = path.join(dir, 'mirror');
    mirror = new SessionMirror(mirrorRoot);
  });
  teardown(async () => {
    for (const c of cleanups.splice(0)) { await c(); }
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function host(opts: { ownership?: boolean; providers?: string[] } = {}) {
    const ws = path.join(dir, 'ws');
    const store = new TranscriptStore(ws);
    const sent: HostToWebview[] = [];
    const providers = new Map<string, AgentProvider>((opts.providers ?? ['fake']).map((id) =>
      [id, new FakeProvider(() => [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }])]));
    const manager = new SessionManager(store, providers, (m) => sent.push(m));
    const ownership = opts.ownership === false ? undefined : new SessionOwnership(path.join(ws, 'sessions'), 'vscode', { heartbeatMs: 20 });
    if (ownership) { manager.setOwnership(ownership, { tailIntervalMs: 20 }); }
    manager.setRemoteSessions(new RemoteSessions({ root: mirrorRoot, windowProjects: async () => new Set(['github.com/a/b']), tailIntervalMs: 20 }));
    await manager.init();
    cleanups.push(async () => { await manager.dispose(); await ownership?.dispose(); });
    return { manager, sent, store, ws };
  }

  async function mirrorSession(state = remoteState(), items = [item('a'), item('b')], deviceId = 'devA') {
    await mirror.setDevices([{ deviceId, name: 'PC-desk', online: true, lastSeenAt: 100 }]);
    await mirror.apply(deviceId, { type: 'session-meta', v: 1, sessionId: state.id, projectId: state.projectId!, relCwd: 'src', branch: 'main', state: publishedState(state) });
    await mirror.apply(deviceId, { type: 'session-ops', v: 1, sessionId: state.id, rev: 1, ops: items.map((i) => ({ op: 'append' as const, item: i })) });
    await mirror.flush();
  }

  test('a mirrored row of the window\'s project is in the roster with its device; another project\'s is not', async () => {
    await mirrorSession();
    await mirrorSession(remoteState({ id: 'r2', projectId: 'github.com/other/repo' }));
    const h = await host();
    await h.manager.syncRoster();
    const rows = h.manager.summaries().filter((s) => s.remote);
    assert.deepStrictEqual(rows.map((s) => [s.id, s.remote?.deviceName, s.remote?.online, s.remote?.relCwd, s.remote?.branch]), [['r1', 'PC-desk', true, 'src', 'main']]);
    assert.strictEqual(h.manager.isRemote('r1'), true);
  });

  test('a remote row never reaches index.json, with or without ownership', async () => {
    await mirrorSession();
    for (const ownership of [true, false]) {
      const h = await host({ ownership });
      await h.manager.syncRoster();
      if (!ownership) { await h.manager.syncRemoteSessions(); }
      assert.strictEqual(h.manager.isRemote('r1'), true, `listed (ownership ${ownership})`);
      await h.manager.persistNow();
      const index = JSON.parse(await fs.readFile(path.join(h.ws, 'index.json'), 'utf8')) as { sessions: SessionState[] };
      assert.deepStrictEqual(index.sessions.map((s) => s.id), [], `ownership ${ownership}`);
      await cleanups.pop()!();
    }
  });

  test('revealing a remote row shows its transcript read-only, without a lease, a provider or its cwd', async () => {
    await mirrorSession(remoteState({ providerId: 'codex' }));
    const h = await host();
    await h.manager.syncRoster();
    await h.manager.setVisible(['r1']);
    const snap = h.sent.find((m) => m.t === 'session-snapshot' && m.session.id === 'r1');
    assert.strictEqual(snap?.t === 'session-snapshot' && snap.session.items.map((i) => i.id).join(','), 'a,b');
    assert.strictEqual(await fs.stat(path.join(h.ws, 'sessions', 'r1.lock')).then(() => true, () => false), false);
    assert.strictEqual(h.manager.isForeign('r1'), true);
  });

  test('a later op in the mirror arrives as a patch', async () => {
    await mirrorSession();
    const h = await host();
    await h.manager.syncRoster();
    await h.manager.setVisible(['r1']);
    await mirror.apply('devA', { type: 'session-ops', v: 1, sessionId: 'r1', rev: 2, ops: [{ op: 'append', item: item('c') }] });
    await mirror.flush();
    await until(() => h.sent.some((m) => m.t === 'session-patch' && m.id === 'r1' && m.patch.op === 'append' && m.patch.item.id === 'c'), 'patch c');
  });

  test('a running row of an offline device reads idle', async () => {
    await mirrorSession(remoteState({ status: 'running' }));
    await mirror.setDevices([{ deviceId: 'devA', name: 'PC-desk', online: false, lastSeenAt: 100 }]);
    await mirror.flush();
    const h = await host();
    await h.manager.syncRoster();
    const row = h.manager.summaries().find((s) => s.id === 'r1');
    assert.deepStrictEqual([row?.status, row?.remote?.online, row?.remote?.lastSeenAt], ['idle', false, 100]);
  });

  test('a delete in the mirror drops the row and closes its pane', async () => {
    await mirrorSession();
    const h = await host();
    await h.manager.syncRoster();
    await h.manager.setVisible(['r1']);
    await mirror.apply('devA', { type: 'session-delete', v: 1, sessionId: 'r1' });
    await mirror.flush();
    await h.manager.syncRoster();
    assert.strictEqual(h.manager.summaries().some((s) => s.id === 'r1'), false);
    assert.strictEqual(h.manager.visibleIds().includes('r1'), false);
  });

  test('sending to or deleting a remote session changes nothing', async () => {
    await mirrorSession();
    const h = await host();
    await h.manager.syncRoster();
    const session = await h.manager.open('r1');
    session.send('hello?');
    await new Promise((r) => setTimeout(r, 60));
    await h.manager.remove('r1');
    assert.strictEqual(h.manager.isRemote('r1'), true);
    const items = (await new TranscriptStore(mirrorStoreDir(mirrorRoot, 'devA')).tail('r1', 100)).items.map((i) => i.id);
    assert.deepStrictEqual(items, ['a', 'b']);
  });
});
