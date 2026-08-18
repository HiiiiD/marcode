import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resolve } from 'node:path';
import type { AgentSession } from '../../host/agent-session';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { HostToWebview, SessionStatus, TranscriptItem } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

/**
 * Waits for a condition that a *queued* move satisfies.
 *
 * A queued move is performed from the status sink, so no caller holds its
 * promise: the chain is a store read, a transcript rewrite, a session dispose
 * that drains an event pump, and a rebuild. That is more turns of the loop
 * than `settle()` spends, and the exact count is an implementation detail no
 * test should encode.
 */
async function until(done: () => boolean, what = 'the queued move to land'): Promise<void> {
  // Bounded by wall clock, not by iteration count. A `setImmediate` loop only
  // cycles the event loop — 500 turns of it elapse in a few milliseconds and
  // never wait on the filesystem, so under full-suite load (other suites doing
  // real fs work, the codex smoke tests running) the bound expired before the
  // dispose and flush in this chain had settled. The suite passed in isolation
  // and failed in aggregate, which is the worst way for a test to be wrong.
  const deadline = Date.now() + 5000;
  while (!done()) {
    if (Date.now() > deadline) {
      // Throw rather than return: falling through left the caller asserting on
      // an unchanged roster and reporting `false !== true`, which says nothing
      // about the timeout that actually happened.
      throw new Error(`timed out after 5s waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

/**
 * The transition `AgentSession.setStatus` makes: state first, then the sink.
 * Written out rather than driven through a turn so a test can pick the exact
 * moment the session lands on idle.
 */
/** True once the roster holds a session rebuilt in place of `session`. */
function moved(manager: SessionManager, session: AgentSession): boolean {
  const now = manager.get(session.state.id);
  return now !== undefined && now !== session;
}

function goIdle(manager: SessionManager, session: AgentSession): void {
  session.state.status = 'idle';
  manager.status(session.state.id, 'idle');
}

suite('SessionManager.relocate', () => {
  const dirs: string[] = [];
  const managers: SessionManager[] = [];

  teardown(async () => {
    while (managers.length > 0) { await managers.pop()!.dispose(); }
    while (dirs.length > 0) {
      await fs.rm(dirs.pop()!, { recursive: true, force: true });
    }
  });

  /**
   * A live session at `/repo` with one turn of history and a pending
   * relocation offer (item id `r1`) naming `target`.
   *
   * The offer is appended straight through the store rather than by scripting
   * a `git worktree add` through the provider: this suite is about answering
   * an offer, and Task 5's suite already covers raising one.
   */
  async function withPendingOffer(target: string, status: SessionStatus = 'idle') {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-relocate-'));
    dirs.push(dir);
    const store = new TranscriptStore(dir);
    const provider = new FakeProvider(() => [
      { kind: 'text', delta: 'ok' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const providers = new Map<string, AgentProvider>([['fake', provider]]);
    const emitted: HostToWebview[] = [];
    const manager = new SessionManager(store, providers, (m) => emitted.push(m));
    managers.push(manager);
    await manager.init();

    const session = await manager.create('fake', '/repo');
    session.send('plan the feature');
    await settle();

    const to = resolve(target);
    store.append(session.state.id, {
      id: 'r1', ts: Date.now(), role: 'relocation', path: to, state: 'pending',
    });
    session.state.status = status;
    return { manager, session, provider, emitted, store, target: to };
  }

  test('moves cwd and marks the item moved', async () => {
    const { manager, session, store } = await withPendingOffer('/repo/../t/a');
    await manager.relocate(session.state.id, 'r1', true);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd.endsWith('a'), true);

    const item = await store.find(session.state.id, 'r1');
    assert.strictEqual(item?.role === 'relocation' && item.state, 'moved');
  });

  test('declining leaves cwd alone and marks the item stayed', async () => {
    const { manager, session, store } = await withPendingOffer('/repo/../t/a');
    const before = session.state.cwd;
    await manager.relocate(session.state.id, 'r1', false);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd, before);

    const item = await store.find(session.state.id, 'r1');
    assert.strictEqual(item?.role === 'relocation' && item.state, 'stayed');
  });

  test('answering twice is a no-op the second time', async () => {
    const { manager, session } = await withPendingOffer('/repo/../t/a');
    await manager.relocate(session.state.id, 'r1', false);
    const before = manager.get(session.state.id)!.state.cwd;
    await manager.relocate(session.state.id, 'r1', true);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd, before);
  });

  test('reuses an existing thread for a directory already visited', async () => {
    const { manager, session, provider, target } = await withPendingOffer('/repo/../t/a');
    session.state.resumeTokens[`fake:${target}`] = 'known-token';
    await manager.relocate(session.state.id, 'r1', true);
    assert.strictEqual(provider.lastStart!.resumeToken, 'known-token');
    assert.strictEqual(manager.get(session.state.id)!.pendingSeedText, undefined);
  });

  test('seeds a fresh thread when the directory has no token', async () => {
    const { manager, session, provider } = await withPendingOffer('/repo/../t/a');
    await manager.relocate(session.state.id, 'r1', true);
    assert.strictEqual(provider.lastStart!.resumeToken, undefined);
    assert.strictEqual(manager.get(session.state.id)!.pendingSeedText!.length > 0, true);
  });

  test('defers the move while the session is running', async () => {
    const { manager, session, store } = await withPendingOffer('/repo/../t/a', 'running');
    const before = session.state.cwd;
    await manager.relocate(session.state.id, 'r1', true);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd, before);

    // Deferred, and the deferral is *state*: the item says so, so the card
    // can stop asking a question the user already answered. It is not
    // settled — nothing has moved — and `reconcileQueuedMoves` is what stops
    // it outliving the in-memory queue.
    const item = await store.find(session.state.id, 'r1');
    assert.strictEqual(item?.role === 'relocation' && item.state, 'queued');
  });

  test('cancelling a queued move returns the item to pending', async () => {
    const { manager, session, store } = await withPendingOffer('/repo/../t/a', 'running');
    const id = session.state.id;
    const before = session.state.cwd;
    await manager.relocate(id, 'r1', true);
    await manager.cancelRelocation(id, 'r1');

    // Back to the question, not to an outcome: the user called the move off,
    // which is not the same as answering Stay.
    const item = await store.find(id, 'r1');
    assert.strictEqual(item?.role === 'relocation' && item.state, 'pending');

    goIdle(manager, session);
    await settle();
    assert.strictEqual(manager.get(id)!.state.cwd, before);
    assert.strictEqual(moved(manager, session), false);
  });

  test('cancelling an offer that is not queued changes nothing', async () => {
    const { manager, session, store } = await withPendingOffer('/repo/../t/a');
    await manager.relocate(session.state.id, 'r1', false);
    await manager.cancelRelocation(session.state.id, 'r1');

    // A settled item is a record, and cancel must not reopen it.
    const item = await store.find(session.state.id, 'r1');
    assert.strictEqual(item?.role === 'relocation' && item.state, 'stayed');
  });

  test('a queued item whose queue entry is gone comes back as pending', async () => {
    const { manager, session, store, target } = await withPendingOffer('/repo/../t/a', 'running');
    const id = session.state.id;
    await manager.relocate(id, 'r1', true);

    // A reload: the index and the transcript survive on disk, the queue does
    // not. Everything below is a second host over the same rootDir.
    const dir = dirs[dirs.length - 1];
    await manager.dispose();
    managers.pop();

    const store2 = new TranscriptStore(dir);
    const emitted: HostToWebview[] = [];
    const providers = new Map<string, AgentProvider>([
      ['fake', new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }])],
    ]);
    const revived = new SessionManager(store2, providers, (m) => emitted.push(m));
    managers.push(revived);
    await revived.init();
    await revived.setVisible([id]);

    const item = await store2.find(id, 'r1');
    assert.strictEqual(item?.role === 'relocation' && item.state, 'pending');
    assert.strictEqual(item?.role === 'relocation' && item.path, target);

    // And the snapshot the pane was actually given says the same thing —
    // reconciling only the store would leave the reload rendering a move
    // nothing is left to perform.
    const snap = emitted.find((m) => m.t === 'session-snapshot');
    const shown = snap?.t === 'session-snapshot'
      ? snap.session.items.find((i) => i.id === 'r1') : undefined;
    assert.strictEqual(shown?.role === 'relocation' && shown.state, 'pending');

    // And nothing revived the queue: reaching idle performs no move.
    revived.status(id, 'idle');
    await settle();
    const after = await store2.find(id, 'r1');
    assert.strictEqual(after?.role === 'relocation' && after.state, 'pending');
    assert.strictEqual(revived.summaries().find((s) => s.id === id)!.cwd, session.state.cwd);
  });

  test('performs the queued move when the session goes idle', async () => {
    const { manager, session, store } = await withPendingOffer('/repo/../t/a', 'running');
    const id = session.state.id;
    await manager.relocate(id, 'r1', true);

    goIdle(manager, session);
    // The rebuilt session, not just the repointed cwd: `moveTo` sets `cwd`
    // early and only puts the new session in the roster at the end.
    await until(() => moved(manager, session));

    assert.strictEqual(manager.get(id)!.state.cwd.endsWith('a'), true);
    const item = await store.find(id, 'r1');
    assert.strictEqual(item?.role === 'relocation' && item.state, 'moved');
  });

  test('a real turn ending performs the queued move', async () => {
    const { manager, session, provider } = await withPendingOffer('/repo/../t/a', 'running');
    const id = session.state.id;
    await manager.relocate(id, 'r1', true);

    provider.runs[provider.runs.length - 1].emit({ kind: 'turn-end', reason: 'done' });
    await until(() => moved(manager, session));

    assert.strictEqual(manager.get(id)!.state.cwd.endsWith('a'), true);
  });

  test('a queued move is performed once, not on every idle', async () => {
    const { manager, session, provider } = await withPendingOffer('/repo/../t/a', 'running');
    const id = session.state.id;
    await manager.relocate(id, 'r1', true);

    goIdle(manager, session);
    await until(() => moved(manager, session));
    const starts = provider.starts.length;
    const cwd = manager.get(id)!.state.cwd;

    manager.status(id, 'idle');
    await settle();
    assert.strictEqual(provider.starts.length, starts);
    assert.strictEqual(manager.get(id)!.state.cwd, cwd);
  });

  test('a second Move click replaces the queued move rather than queueing two', async () => {
    const { manager, session, provider } = await withPendingOffer('/repo/../t/a', 'running');
    const id = session.state.id;
    await manager.relocate(id, 'r1', true);
    await manager.relocate(id, 'r1', true);

    goIdle(manager, session);
    await until(() => moved(manager, session));
    await settle();
    // One rebuild, not two: `starts` grew by exactly the move's own restart.
    assert.strictEqual(provider.starts.length, 2);
    assert.strictEqual(manager.get(id)!.state.cwd.endsWith('a'), true);
  });

  test('declining while running settles immediately and queues nothing', async () => {
    const { manager, session, store } = await withPendingOffer('/repo/../t/a', 'running');
    const id = session.state.id;
    const before = session.state.cwd;
    await manager.relocate(id, 'r1', false);

    const item = await store.find(id, 'r1');
    assert.strictEqual(item?.role === 'relocation' && item.state, 'stayed');

    goIdle(manager, session);
    await settle();
    assert.strictEqual(manager.get(id)!.state.cwd, before);
  });

  test('closing a session with a queued move moves nothing and does not throw', async () => {
    const { manager, session } = await withPendingOffer('/repo/../t/a', 'running');
    const id = session.state.id;
    const before = session.state.cwd;
    await manager.relocate(id, 'r1', true);

    await manager.close(id);
    manager.status(id, 'idle');
    await settle();

    assert.strictEqual(manager.get(id), undefined);
    assert.strictEqual(session.state.cwd, before);
  });

  test('the seed rides the next send and is spent there', async () => {
    const { manager, session, provider } = await withPendingOffer('/repo/../t/a');
    await manager.relocate(session.state.id, 'r1', true);
    const moved = manager.get(session.state.id)!;

    moved.send('now implement it');
    await settle();
    const first = provider.sent[provider.sent.length - 1].text;
    assert.strictEqual(first.includes('already happened'), true);
    assert.strictEqual(first.includes('plan the feature'), true);
    assert.strictEqual(first.endsWith('now implement it'), true);

    moved.send('and again');
    await settle();
    assert.strictEqual(provider.sent[provider.sent.length - 1].text, 'and again');
  });

  test('the seed never reaches the transcript', async () => {
    const { manager, session, provider } = await withPendingOffer('/repo/../t/a');
    await manager.relocate(session.state.id, 'r1', true);
    const moved = manager.get(session.state.id)!;

    moved.send('now implement it');
    await settle();
    // The provider saw the seed...
    assert.strictEqual(
      provider.sent[provider.sent.length - 1].text.includes('already happened'), true);

    // ...and the record of what the user said did not.
    const { items } = await moved.snapshot();
    const users = items.filter((i: TranscriptItem) => i.role === 'user');
    const last = users[users.length - 1];
    assert.strictEqual(last.role === 'user' && last.text, 'now implement it');
    assert.strictEqual(
      items.some((i) => JSON.stringify(i).includes('already happened')), false);
  });
});
