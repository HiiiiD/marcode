import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, teardown, test } from 'mocha';
import { SessionManager } from '../../host/session-manager';
import { SessionOwnership } from '../../host/session-ownership';
import { RemoteSessions } from '../../host/sync/remote-sessions';
import { SessionMirror } from '../../host/sync/session-mirror';
import { TranscriptStore } from '../../host/transcript-store';
import type { SessionState } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import { publishedState } from '../../sync/session-records';
import { SyncState } from '../../sync/sync-state';

const cleanups: Array<() => Promise<void> | void> = [];
teardown(async () => { while (cleanups.length) { await cleanups.pop()!(); } });
const tmp = async (p: string) => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p)));
const key = (id: string) => `key-${id}`;

async function rig(self = { deviceId: 'devA', deviceName: 'PC-desk' }) {
  const home = await tmp('mar-ret-');
  const ws = path.join(home, 'ws');
  const store = new TranscriptStore(ws);
  const manager = new SessionManager(store, new Map([['fake', new FakeProvider(() => [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }])]]), () => {});
  const ownership = new SessionOwnership(path.join(ws, 'sessions'), 'vscode', { heartbeatMs: 20 });
  manager.setOwnership(ownership, { tailIntervalMs: 20 });
  const mirrorRoot = path.join(home, 'mirror');
  const state = new SyncState(path.join(home, 'state.sqlite'));
  manager.setRemoteSessions(new RemoteSessions({
    root: mirrorRoot, windowProjects: async () => new Set(['github.com/a/b']), tailIntervalMs: 20,
    owners: { key, self, sync: state },
  }));
  await manager.init();
  cleanups.push(async () => { await manager.dispose(); await ownership.dispose(); state.close(); });
  const mirror = new SessionMirror(mirrorRoot);
  const local = async () => {
    const s = await manager.create('fake', home);
    s.state.projectId = 'github.com/a/b';
    s.send('offline work');
    const deadline = Date.now() + 3000;
    while (s.state.status !== 'idle' && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 10)); }
    await store.flush(s.state.id);
    return s;
  };
  const mirrorCopy = async (deviceId: string, s: SessionState, deviceName: string) => {
    await mirror.setDevices([{ deviceId: 'devB', name: 'PC-laptop', online: true, lastSeenAt: 1 }, { deviceId: 'devA', name: 'PC-desk', online: false, lastSeenAt: 1 }].filter((d) => d.name === deviceName || true));
    await mirror.apply(deviceId, { type: 'session-meta', v: 1, sessionId: s.id, projectId: 'github.com/a/b', relCwd: '.', state: publishedState({ ...s, projectId: 'github.com/a/b' }) });
    await mirror.apply(deviceId, { type: 'session-ops', v: 1, sessionId: s.id, rev: 1, ops: [{ op: 'append', item: { id: 'x1', ts: 1, role: 'user', text: 'from the new owner' } }] });
  };
  const owner = async (id: string, deviceId: string, baseRev: number) => {
    await mirror.setOwners([{ key: key(id), deviceId, epoch: 1, baseRev, updatedAt: 1 }]);
    await mirror.flush();
  };
  return { home, store, manager, state, mirror, local, mirrorCopy, owner };
}

suite('losing a session to another device', () => {
  test('a session handed over cleanly leaves this device and shows as the new owner\'s', async () => {
    const r = await rig();
    const s = await r.local();
    const rev = r.state.nextRevs(s.state.id, 2) + 1;
    await r.mirrorCopy('devB', s.state, 'PC-laptop');
    await r.owner(s.state.id, 'devB', rev);
    await r.manager.syncRoster();
    await r.manager.syncRoster();
    const rows = r.manager.summaries().filter((x) => x.id === s.state.id);
    assert.deepStrictEqual(rows.map((x) => x.remote?.deviceId), ['devB']);
    assert.strictEqual(r.manager.summaries().some((x) => x.title.endsWith('(from PC-desk, offline)')), false);
  });

  test('a session taken over while this device held unsent turns keeps them as a fork', async () => {
    const r = await rig();
    const s = await r.local();
    const id = s.state.id;
    const title = s.state.title;
    r.state.nextRevs(id, 5);
    r.state.enqueue({ type: 'session-ops', v: 1, sessionId: id, rev: 6, ops: [] });
    await r.owner(id, 'devB', 2);
    await r.manager.syncRoster();
    const fork = r.manager.summaries().find((x) => x.title === `${title} (from PC-desk, offline)`);
    assert.strictEqual(fork !== undefined, true);
    assert.deepStrictEqual([fork?.origin, fork?.parentId], ['fork', id]);
    const forkItems = (await new TranscriptStore(r.store.root).tail(fork!.id, 100)).items;
    assert.strictEqual(forkItems.some((i) => i.role === 'user' && i.text === 'offline work'), true);
    assert.strictEqual(r.manager.summaries().some((x) => x.id === id && x.remote === undefined), false);
    const leftover = r.state.peek(1000).map((x) => x.payload as { type: string; sessionId?: string })
      .filter((p) => p.sessionId === id && p.type === 'session-ops');
    assert.deepStrictEqual(leftover, []);
  });

  test("a third device that mirrors both copies lists one row, the owner's", async () => {
    const r = await rig({ deviceId: 'devC', deviceName: 'Tower' });
    const s: SessionState = {
      id: 'both', providerId: 'fake', model: 'm', title: 'T', name: 'n', cwd: '/x', status: 'idle', permissionMode: 'default',
      includeEditorContext: false, resumeTokens: {}, createdAt: 1, updatedAt: 2, projectId: 'github.com/a/b',
    };
    await r.mirrorCopy('devA', s, 'PC-desk');
    await r.mirrorCopy('devB', s, 'PC-laptop');
    await r.owner('both', 'devB', 1);
    await r.manager.syncRoster();
    assert.deepStrictEqual(r.manager.summaries().filter((x) => x.id === 'both').map((x) => x.remote?.deviceId), ['devB']);
  });

  test('a stale record never cedes a session this device holds at a newer epoch', async () => {
    const r = await rig();
    const s = await r.local();
    r.state.setHeldEpoch(s.state.id, 2);
    await r.owner(s.state.id, 'devB', 0);
    await r.manager.syncRoster();
    assert.strictEqual(r.manager.summaries().some((x) => x.id === s.state.id && !x.remote), true);
  });

  test("a session another host on this machine leases is left to that host", async () => {
    const r = await rig();
    const s = await r.local();
    const other = new SessionManager(new TranscriptStore(r.store.root), new Map([['fake', new FakeProvider()]]), () => {});
    const otherOwnership = new SessionOwnership(path.join(r.store.root, 'sessions'), 'tui', { heartbeatMs: 20 });
    other.setOwnership(otherOwnership, { tailIntervalMs: 20 });
    other.setRemoteSessions(new RemoteSessions({
      root: path.join(r.home, 'mirror'), windowProjects: async () => new Set(['github.com/a/b']), owners: { key, self: { deviceId: 'devA', deviceName: 'PC-desk' }, sync: r.state },
    }));
    await other.init();
    cleanups.push(async () => { await other.dispose(); await otherOwnership.dispose(); });
    await r.manager.persistNow();
    await other.syncRoster();
    await r.owner(s.state.id, 'devB', 0);
    await other.syncRoster();
    assert.strictEqual(await fs.stat(path.join(r.store.root, 'sessions', `${s.state.id}.jsonl`)).then(() => true, () => false), true);
    assert.strictEqual(other.summaries().filter((x) => x.title.endsWith('(from PC-desk, offline)')).length, 0);
  });
});
