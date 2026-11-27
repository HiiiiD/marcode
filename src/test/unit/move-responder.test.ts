import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, teardown, test } from 'mocha';
import { SessionManager } from '../../host/session-manager';
import { SessionOwnership } from '../../host/session-ownership';
import { MoveResponder } from '../../host/sync/move-responder';
import { SessionMirror } from '../../host/sync/session-mirror';
import { SessionPublisher } from '../../host/sync/session-publisher';
import { ThreadPublisher } from '../../host/sync/thread-publisher';
import { TranscriptStore } from '../../host/transcript-store';
import type { AgentEvent } from '../../providers/types';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { MoveReplyPayload } from '../../sync/move-records';
import { SyncState } from '../../sync/sync-state';

const cleanups: Array<() => Promise<void> | void> = [];
teardown(async () => { while (cleanups.length) { await cleanups.pop()!(); } });

const tmp = async (p: string) => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p)));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd, stdio: 'ignore' });

async function pushedRepo(): Promise<string> {
  const origin = await tmp('mar-origin-');
  git(origin, 'init', '-q', '--bare');
  const repo = await tmp('mar-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  await fs.writeFile(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'i');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  return repo;
}

const until = async (done: () => boolean | Promise<boolean>, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!(await done())) { if (Date.now() > deadline) { throw new Error('timed out'); } await new Promise((r) => setTimeout(r, 20)); }
};

async function rig(
  script: () => AgentEvent[] = () => [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }], claimTimeoutMs = 60_000,
  opts: { threadFile?: string; ownerOf?: (id: string) => Promise<{ deviceId: string } | undefined> } = {},
) {
  const repo = await pushedRepo();
  const home = await tmp('mar-src-home-');
  const store = new TranscriptStore(path.join(home, 'ws'));
  const fake = new FakeProvider(script);
  const provider = opts.threadFile ? Object.assign(fake, { threadFiles: async () => [opts.threadFile!] }) : fake;
  const manager = new SessionManager(store, new Map([['fake', provider]]), () => {});
  const ownership = new SessionOwnership(path.join(home, 'ws', 'sessions'), 'vscode', { heartbeatMs: 20 });
  manager.setOwnership(ownership, { tailIntervalMs: 20 });
  await manager.init();
  const state = new SyncState(path.join(home, 'state.sqlite'));
  const sessions = new SessionPublisher({
    store, state, excluded: [], publishable: (id) => manager.publishableSession(id), relCwd: async () => '.', branch: async () => 'main',
  });
  sessions.start();
  const threads = new ThreadPublisher({ state, providers: new Map([['fake', provider]]), publishable: (id) => manager.publishableSession(id), excluded: [] });
  const mirrorRoot = path.join(home, 'mirror');
  const mirror = new SessionMirror(mirrorRoot);
  const responder = new MoveResponder({ manager, state, sessions, threads, mirrorRoot, deviceName: 'PC-desk', pollMs: 20, claimTimeoutMs, selfDeviceId: 'devA', ...(opts.ownerOf ? { ownerOf: opts.ownerOf } : {}) });
  responder.start();
  cleanups.push(async () => { responder.dispose(); sessions.dispose(); await manager.dispose(); await ownership.dispose(); state.close(); });
  const session = await manager.create('fake', repo);
  session.state.projectId = 'github.com/a/b';
  if (opts.threadFile) { session.state.resumeTokens[`fake:${repo}`] = 'tok'; }
  const ask = (over: { cancelTurn?: boolean; sessionId?: string } = {}) => mirror.applyMove('devB', {
    type: 'move-request', v: 1, sessionId: over.sessionId ?? session.state.id, requestId: `q-${Math.random()}`, to: 'devB', cancelTurn: over.cancelTurn ?? false,
  });
  const replies = () => state.peek(1000).map((r) => r.payload as MoveReplyPayload).filter((p) => p.type === 'move-reply');
  return { repo, manager, store, state, session, ask, replies };
}

suite('MoveResponder', function () {
  this.timeout(15_000);

  test('a clean, pushed session is handed over after its turn, with the last rev, and goes read-only', async () => {
    const r = await rig();
    r.session.send('first');
    await until(() => r.session.state.status === 'idle' && r.state.outboxSize() > 0);
    await r.ask();
    await until(() => r.replies().length === 1);
    const [reply] = r.replies();
    assert.strictEqual(reply.ok, true);
    assert.strictEqual(reply.ok && reply.lastRev, r.state.publishedRev(r.session.state.id));
    assert.strictEqual(r.manager.isForeign(r.session.state.id), true);
    const before = (await new TranscriptStore(r.store.root).tail(r.session.state.id, 1000)).items.length;
    (await r.manager.open(r.session.state.id)).send('after the hand-over');
    await new Promise((res) => setTimeout(res, 100));
    await r.store.flush();
    assert.strictEqual((await new TranscriptStore(r.store.root).tail(r.session.state.id, 1000)).items.length, before);
  });

  test('cancelTurn interrupts a running turn before handing over', async () => {
    const r = await rig(() => [{ kind: 'text', delta: 'working…' }]);
    r.session.send('long job');
    await until(() => r.session.state.status === 'running');
    await r.ask({ cancelTurn: true });
    await until(() => r.replies().length === 1);
    assert.strictEqual(r.replies()[0].ok, true);
  });

  test('a checkout with changes or without an upstream is refused with its reason', async () => {
    const r = await rig();
    await fs.writeFile(path.join(r.repo, 'a.txt'), 'changed');
    await r.ask();
    await until(() => r.replies().length === 1);
    assert.deepStrictEqual(r.replies()[0], { ...r.replies()[0], ok: false, reason: 'Push your changes on PC-desk first: 1 modified files, 0 unpushed commits.' });
    git(r.repo, 'checkout', '-q', '.');
    git(r.repo, 'checkout', '-q', '-b', 'local-only');
    await r.ask();
    await until(() => r.replies().length === 2);
    assert.strictEqual(r.replies()[1].ok === false && r.replies()[1].ok === false && (r.replies()[1] as { reason: string }).reason,
      'Push your changes on PC-desk first: this branch has no upstream.');
    assert.strictEqual(r.manager.isForeign(r.session.state.id), false);
  });

  test('a session with an open side chat is refused', async () => {
    const r = await rig();
    r.session.send('hi');
    await until(() => r.session.state.status === 'idle');
    await r.manager.startSideChat(r.session.state.id, 'aside');
    await r.ask();
    await until(() => r.replies().length === 1);
    assert.strictEqual((r.replies()[0] as { reason?: string }).reason, 'This session has an open side chat on PC-desk.');
  });

  test('a request for a session this host does not own gets no answer here', async () => {
    const r = await rig();
    await r.ask({ sessionId: 'someone-else' });
    await new Promise((res) => setTimeout(res, 200));
    assert.deepStrictEqual(r.replies(), []);
  });

  test('a hand-over nobody claims in time is taken back and writable again', async () => {
    const r = await rig(undefined, 200);
    r.session.send('first');
    await until(() => r.session.state.status === 'idle');
    await r.ask();
    await until(() => r.replies().length === 1);
    assert.strictEqual(r.manager.isForeign(r.session.state.id), true);
    await until(() => !r.manager.isForeign(r.session.state.id), 3000);
  });

  test("the reply carries the agent thread, uploaded at hand-over time", async () => {
    const thread = path.join(await tmp('mar-thread-'), 'tok.jsonl');
    await fs.writeFile(thread, '{"a":1}\n');
    const r = await rig(undefined, 60_000, { threadFile: thread });
    r.session.send('first');
    await until(() => r.session.state.status === 'idle');
    await r.ask();
    await until(() => r.replies().length === 1);
    const [reply] = r.replies();
    assert.deepStrictEqual(reply.ok && reply.thread, { generation: 1, bytes: 8 });
  });

  test('a second request for a session already handed over is refused at once', async () => {
    const r = await rig();
    r.session.send('first');
    await until(() => r.session.state.status === 'idle');
    await r.ask();
    await until(() => r.replies().length === 1);
    await r.ask();
    await until(() => r.replies().length === 2);
    assert.deepStrictEqual((r.replies()[1] as { ok: boolean; reason?: string }).reason, 'PC-desk already handed this session to another device.');
  });

  test('a hand-over the server shows as claimed is never taken back', async () => {
    const r = await rig(undefined, 200, { ownerOf: async () => ({ deviceId: 'devB' }) });
    r.session.send('first');
    await until(() => r.session.state.status === 'idle');
    await r.ask();
    await until(() => r.replies().length === 1);
    await new Promise((res) => setTimeout(res, 500));
    assert.strictEqual(r.manager.isForeign(r.session.state.id), true);
  });
});
