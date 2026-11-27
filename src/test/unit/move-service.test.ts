import * as assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, teardown, test } from 'mocha';
import { ProjectResolver } from '../../host/project/project-resolver';
import { SessionManager } from '../../host/session-manager';
import { SessionOwnership } from '../../host/session-ownership';
import { MoveService, type MoveStatus } from '../../host/sync/move-service';
import { RemoteSessions } from '../../host/sync/remote-sessions';
import { SessionMirror } from '../../host/sync/session-mirror';
import { TranscriptStore } from '../../host/transcript-store';
import type { SessionState, TranscriptItem } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';
import { writeCredentials } from '../../sync/credentials';
import { chunkFile, type MoveRequestPayload } from '../../sync/move-records';
import { encodeCode } from '../../sync/pairing-code';
import { publishedState } from '../../sync/session-records';
import { SyncClient } from '../../sync/sync-client';
import { SyncState } from '../../sync/sync-state';
import { hashSecret } from '../../sync-server/auth';
import { startSyncServer } from '../../sync-server/server';
import { SyncStore } from '../../sync-server/store';

const cleanups: Array<() => Promise<void> | void> = [];
teardown(async () => { while (cleanups.length) { await cleanups.pop()!(); } });
const tmp = async (p: string) => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p)));
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) { throw new Error(r.error); } return r.value; };
const item = (id: string, text: string): TranscriptItem => ({ id, ts: 1, role: 'user', text });

async function world(opts: { threads?: boolean; online?: boolean; lastSeenAt?: number; now?: () => number; racer?: boolean } = {}) {
  const store = new SyncStore(path.join(await tmp('mar-ms-srv-'), 's.sqlite'));
  const bytes = randomBytes(16);
  store.setBootstrap(hashSecret(bytes));
  const server = await startSyncServer({ store, host: '127.0.0.1', port: 0 });
  cleanups.push(async () => { await server.close(); store.close(); });
  const a = ok(await SyncClient.enroll(server.url, encodeCode('MRB', bytes), 'PC-desk'));
  const pairing = ok(await new SyncClient(a).createPairing());
  const b = ok(await SyncClient.join(server.url, pairing.code, 'PC-laptop'));

  const home = await tmp('mar-ms-home-');
  await writeCredentials(home, b);
  const root = await tmp('mar-ms-checkout-');
  const mirrorRoot = path.join(home, 'sync', 'mirror');
  const mirror = new SessionMirror(mirrorRoot);
  const cfg = await tmp('mar-ms-claude-');
  const imported: Array<{ cwd: string; text: string }> = [];
  const providers = new Map<string, AgentProvider>([['fake', new FakeProvider(() => [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }])]]);
  if (opts.threads) {
    providers.set('threads', Object.assign(new FakeProvider(), {
      id: 'threads', threadScope: 'cwd' as const,
      importThread: async (args: { resumeToken: string; cwd: string; files: Array<{ name: string; text: string }> }) => {
        imported.push({ cwd: args.cwd, text: args.files[0].text });
        return { resumeToken: args.resumeToken };
      },
    }) as unknown as AgentProvider);
  }
  const ws = path.join(home, 'ws');
  const manager = new SessionManager(new TranscriptStore(ws), providers, () => {});
  const ownership = new SessionOwnership(path.join(ws, 'sessions'), 'vscode', { heartbeatMs: 20 });
  manager.setOwnership(ownership, { tailIntervalMs: 20 });
  manager.setRemoteSessions(new RemoteSessions({ root: mirrorRoot, windowProjects: async () => new Set(['github.com/a/b']), tailIntervalMs: 20 }));
  await manager.init();
  const state = new SyncState(path.join(home, 'sync', 'state.sqlite'));
  const service = new MoveService({
    manager, state, home, mirrorRoot, roots: () => [root], projects: new ProjectResolver([]),
    takeOverAfterMs: 10 * 60_000, replyTimeoutMs: 1500, mirrorTimeoutMs: 1500, pollMs: 20, now: opts.now,
    // The racer: another device claims the same epoch a moment before this one does.
    ...(opts.racer ? { client: (creds) => new (class extends SyncClient {
      override async claimOwner(id: string, claim: { epoch: number; expect: number; baseRev: number }) {
        await new SyncClient(a).claimOwner(id, claim);
        return super.claimOwner(id, claim);
      }
    })(creds) } : {}),
  });
  cleanups.push(async () => { await manager.dispose(); await ownership.dispose(); state.close(); });

  const providerId = opts.threads ? 'threads' : 'fake';
  const srcRoot = '/src/desk/repo';
  const source: SessionState = {
    id: 'mv1', providerId, model: 'm', title: 'Moving work', name: 'mover', cwd: `${srcRoot}/pkg`, status: 'idle', permissionMode: 'default',
    includeEditorContext: false, resumeTokens: { [`${providerId}:${srcRoot}/pkg`]: 'tok' }, createdAt: 1, updatedAt: 2, projectId: 'github.com/a/b',
  };
  await mirror.setDevices([{ deviceId: a.deviceId, name: 'PC-desk', online: opts.online ?? true, lastSeenAt: opts.lastSeenAt ?? Date.now() }]);
  await mirror.apply(a.deviceId, { type: 'session-meta', v: 1, sessionId: 'mv1', projectId: 'github.com/a/b', relCwd: 'pkg', branch: 'main', state: publishedState(source) });
  await mirror.apply(a.deviceId, { type: 'session-ops', v: 1, sessionId: 'mv1', rev: 1, ops: [{ op: 'append', item: item('u1', 'do the work') }] });
  if (opts.threads) {
    const text = `${JSON.stringify({ cwd: `${srcRoot}/pkg`, file: `${srcRoot}/pkg/a.ts` })}\n`;
    for (const c of chunkFile({ type: 'thread-chunk', sessionId: 'mv1', providerId, name: 'tok.jsonl', generation: 1 }, Buffer.from(text), 0)) { await mirror.applyMove(a.deviceId, c); }
  }
  await mirror.flush();
  await manager.syncRoster();

  /** Plays the source: answers the request that B queued. */
  const answer = async (body: { ok: true; lastRev: number; thread?: { generation: number; bytes: number } } | { ok: false; reason: string }) => {
    const deadline = Date.now() + 3000;
    let request: MoveRequestPayload | undefined;
    while (!request && Date.now() < deadline) {
      request = state.peek(100).map((r) => r.payload as MoveRequestPayload).find((p) => p.type === 'move-request');
      if (!request) { await new Promise((r) => setTimeout(r, 10)); }
    }
    if (!request) { throw new Error('no request'); }
    await mirror.applyMove(a.deviceId, { type: 'move-reply', v: 1, sessionId: 'mv1', requestId: request.requestId, ...body } as never);
  };
  return { server, a, b, home, root, mirror, manager, service, state, answer, imported, srcRoot };
}

const run = (work: (on: (s: MoveStatus) => void) => Promise<void>) => {
  const seen: MoveStatus[] = [];
  return work((s) => { seen.push(s); }).then(() => seen);
};

suite('MoveService', function () {
  this.timeout(20_000);

  test('a move lands here as a local session under the chosen checkout, restarted from the transcript', async () => {
    const w = await world();
    const seen = run((on) => w.service.moveHere('mv1', { root: w.root }, { cancelTurn: false }, on));
    await w.answer({ ok: true, lastRev: 1 });
    const last = (await seen).at(-1);
    assert.deepStrictEqual(last, { state: 'done', sessionId: 'mv1', thread: 'restarted' });
    const row = w.manager.summaries().find((s) => s.id === 'mv1');
    assert.deepStrictEqual([row?.remote, row?.cwd], [undefined, path.join(w.root, 'pkg')]);
    const items = (await new TranscriptStore(path.join(w.home, 'ws')).tail('mv1', 100)).items;
    assert.deepStrictEqual(items.map((i) => i.id).slice(0, 1), ['u1']);
    assert.strictEqual(JSON.stringify(items.at(-1)).includes('Moved here from PC-desk. The agent restarted from the transcript; earlier tool output is not in its context.'), true);
    const owners = ok(await new SyncClient(w.b).owners());
    assert.deepStrictEqual(owners.map((o) => [o.deviceId, o.epoch, o.baseRev]), [[w.b.deviceId, 1, 1]]);
  });

  test('a provider that imports threads gets the thread with its paths rewritten to this checkout', async () => {
    const w = await world({ threads: true });
    const seen = run((on) => w.service.moveHere('mv1', { root: w.root }, { cancelTurn: false }, on));
    await w.answer({ ok: true, lastRev: 1, thread: { generation: 1, bytes: 10 } });
    assert.deepStrictEqual((await seen).at(-1), { state: 'done', sessionId: 'mv1', thread: 'restored' });
    assert.strictEqual(w.imported[0].cwd, path.join(w.root, 'pkg'));
    assert.strictEqual(w.imported[0].text.includes(`${path.join(w.root, 'pkg', 'a.ts')}`), true);
    assert.strictEqual(w.imported[0].text.includes(w.srcRoot), false);
  });

  test('a claim another device wins first fails the move and leaves the session remote', async () => {
    const w = await world({ racer: true });
    const seen = run((on) => w.service.moveHere('mv1', { root: w.root }, { cancelTurn: false }, on));
    await w.answer({ ok: true, lastRev: 1 });
    assert.deepStrictEqual((await seen).at(-1), { state: 'failed', reason: 'Moved to PC-desk by another request.' });
    assert.strictEqual(w.manager.isRemote('mv1'), true);
    assert.strictEqual(w.manager.summaries().filter((x) => x.id === 'mv1').length, 1);
  });

  test("a refusal from the source fails the move with the source's reason", async () => {
    const w = await world();
    const seen = run((on) => w.service.moveHere('mv1', { root: w.root }, { cancelTurn: false }, on));
    await w.answer({ ok: false, reason: 'Push your changes on PC-desk first: this branch has no upstream.' });
    assert.deepStrictEqual((await seen).at(-1), { state: 'failed', reason: 'Push your changes on PC-desk first: this branch has no upstream.' });
    assert.strictEqual(w.manager.isRemote('mv1'), true);
  });

  test('a source that never answers fails the move after the timeout', async () => {
    const w = await world();
    const seen = await run((on) => w.service.moveHere('mv1', { root: w.root }, { cancelTurn: false }, on));
    assert.deepStrictEqual(seen.at(-1), { state: 'failed', reason: 'PC-desk did not answer. Is it running Marcode and online?' });
  });

  test('take over waits for the owner to be gone long enough, then claims from the mirror', async () => {
    const now = { t: Date.now() };
    const early = await world({ online: false, lastSeenAt: now.t - 60_000, now: () => now.t });
    assert.strictEqual(early.service.canTakeOver('mv1'), false);
    const late = await world({ online: false, lastSeenAt: now.t - 11 * 60_000, now: () => now.t });
    assert.strictEqual(late.service.canTakeOver('mv1'), true);
    const seen = await run((on) => late.service.takeOver('mv1', { root: late.root }, on));
    assert.deepStrictEqual(seen.at(-1), { state: 'done', sessionId: 'mv1', thread: 'restarted' });
    const items = (await new TranscriptStore(path.join(late.home, 'ws')).tail('mv1', 100)).items;
    assert.strictEqual(JSON.stringify(items.at(-1)).includes('Taken over from PC-desk (last seen '), true);
    const online = await world({ online: true });
    assert.strictEqual(online.service.canTakeOver('mv1'), false);
  });

  test('a worktree that cannot be made stops the move before anything is asked or claimed', async () => {
    const w = await world();
    const seen = await run((on) => w.service.moveHere('mv1', { createWorktree: 'feat/x' }, { cancelTurn: false }, on));
    assert.deepStrictEqual(seen.at(-1), { state: 'failed', reason: 'No checkout of this project is open here to add a worktree to.' });
    assert.strictEqual(w.state.peek(100).some((r) => (r.payload as { type: string }).type === 'move-request'), false);
    assert.deepStrictEqual(ok(await new SyncClient(w.b).owners()), []);
  });

  test('a checkout on another branch stops the move before anything is asked', async () => {
    const w = await world();
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q', '-b', 'other', w.root]);
    execFileSync('git', ['-C', w.root, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'i']);
    const seen = await run((on) => w.service.moveHere('mv1', { root: w.root }, { cancelTurn: false }, on));
    assert.deepStrictEqual(seen.at(-1), { state: 'failed', reason: `${w.root} is on other, not main. Pick a checkout on main or create a worktree for it.` });
    assert.strictEqual(w.state.peek(100).some((r) => (r.payload as { type: string }).type === 'move-request'), false);
  });
});
