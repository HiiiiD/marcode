import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentSession, type SessionSink } from '../../host/agent-session';
import { TranscriptStore } from '../../host/transcript-store';
import type {
  Invocable, SessionId, SessionState, SessionStatus, TranscriptPatch,
} from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { UsageWindow } from '../../providers/types';

function baseState(): SessionState {
  return {
    id: 's1', providerId: 'fake', model: 'fake-large', effort: 'medium',
    title: 'Untitled', cwd: '/repo', status: 'idle', permissionMode: 'default',
    includeEditorContext: true,
    resumeTokens: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

class RecordingSink implements SessionSink {
  statuses: SessionStatus[] = [];
  changes = 0;
  patch(_id: SessionId, _patch: TranscriptPatch) { /* not asserted here */ }
  status(_id: SessionId, status: SessionStatus) { this.statuses.push(status); }
  mcp(_id: SessionId, _servers: unknown[]) { /* not asserted here */ }
  changed() { this.changes++; }
  invocables(_id: SessionId, _entries: Invocable[]) { /* not asserted here */ }
  usageWindows(_providerId: string, _windows: UsageWindow[] | undefined) { /* not asserted */ }
}

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('AgentSession queued message', () => {
  let dir: string;
  let store: TranscriptStore;
  const open: AgentSession[] = [];

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-queue-'));
    store = new TranscriptStore(dir);
  });

  teardown(async () => {
    while (open.length > 0) { await open.pop()!.dispose(); }
    await fs.rm(dir, { recursive: true, force: true });
  });

  /**
   * A session whose provider never ends the turn on its own, so a test drives
   * the turn boundary itself through `run.emit` — which is exactly the seam a
   * queued message hangs off.
   */
  function makeSession() {
    const provider = new FakeProvider();
    const sink = new RecordingSink();
    const session = new AgentSession(baseState(), provider, store, sink);
    open.push(session);
    return { provider, sink, session };
  }

  test('a send while the turn is running is queued, not forwarded', async () => {
    const { provider, session } = makeSession();
    session.send('first');
    await settle();

    session.send('second');
    await settle();

    assert.strictEqual(provider.sent.length, 1);
    assert.strictEqual(provider.sent[0].text, 'first');
    assert.strictEqual(session.state.queued?.[0]?.text, 'second');
    const snap = await session.snapshot();
    assert.strictEqual(snap.items.filter((i) => i.role === 'user').length, 1);
  });

  test('the queued message is sent when the turn ends', async () => {
    const { provider, session } = makeSession();
    session.send('first');
    await settle();
    session.send('second');
    await settle();

    provider.runs[0].emit({ kind: 'turn-end', reason: 'done' });
    await settle();

    assert.deepStrictEqual(provider.sent.map((s) => s.text), ['first', 'second']);
    assert.strictEqual(session.state.queued, undefined);
    assert.strictEqual(session.state.status, 'running');
  });

  test('the queued message is sent when the turn is interrupted', async () => {
    const { provider, session } = makeSession();
    session.send('first');
    await settle();
    session.send('second');
    await settle();

    await session.interrupt();
    await settle();

    assert.deepStrictEqual(provider.sent.map((s) => s.text), ['first', 'second']);
    assert.strictEqual(session.state.queued, undefined);
  });

  test('a queued message stays queued while a permission is awaiting approval', async () => {
    const { provider, session } = makeSession();
    session.send('first');
    await settle();
    provider.runs[0].emit({
      kind: 'permission', id: 'r1', tool: { kind: 'command', label: 'Bash', command: 'ls' },
    });
    await settle();

    session.send('second');
    await settle();
    provider.runs[0].emit({ kind: 'turn-end', reason: 'done' });
    await settle();

    assert.strictEqual(session.state.status, 'awaiting-approval');
    assert.strictEqual(session.state.queued?.[0]?.text, 'second');
    assert.strictEqual(provider.sent.length, 1);
  });

  test('several sends while busy queue in order, FIFO, one delivered per turn', async () => {
    const { provider, session } = makeSession();
    session.send('first');
    await settle();
    session.send('second');
    session.send('third');
    await settle();

    assert.deepStrictEqual(session.state.queued?.map((q) => q.text), ['second', 'third']);

    provider.runs[0].emit({ kind: 'turn-end', reason: 'done' });
    await settle();

    // Only the head of the queue is spent on this idle transition — the rest
    // waits for the turn `second` just started to end in its turn.
    assert.deepStrictEqual(provider.sent.map((s) => s.text), ['first', 'second']);
    assert.deepStrictEqual(session.state.queued?.map((q) => q.text), ['third']);

    provider.runs[0].emit({ kind: 'turn-end', reason: 'done' });
    await settle();

    assert.deepStrictEqual(provider.sent.map((s) => s.text), ['first', 'second', 'third']);
    assert.strictEqual(session.state.queued, undefined);
  });

  test('cancelQueued drops one queued message by id, leaving the rest', async () => {
    const { provider, session } = makeSession();
    session.send('first');
    await settle();
    session.send('second');
    session.send('third');
    await settle();

    const secondId = session.state.queued?.[0]?.id;
    assert.ok(secondId);
    session.cancelQueued(secondId!);
    assert.deepStrictEqual(session.state.queued?.map((q) => q.text), ['third']);

    provider.runs[0].emit({ kind: 'turn-end', reason: 'done' });
    await settle();

    assert.deepStrictEqual(provider.sent.map((s) => s.text), ['first', 'third']);
    // 'third' was just delivered as its own turn, so the session is busy
    // again rather than idle.
    assert.strictEqual(session.state.status, 'running');
  });

  test('cancelQueued drops the last queued message so the turn ends without it', async () => {
    const { provider, session } = makeSession();
    session.send('first');
    await settle();
    session.send('second');
    await settle();

    const secondId = session.state.queued?.[0]?.id;
    session.cancelQueued(secondId!);
    assert.strictEqual(session.state.queued, undefined);

    provider.runs[0].emit({ kind: 'turn-end', reason: 'done' });
    await settle();

    assert.deepStrictEqual(provider.sent.map((s) => s.text), ['first']);
    assert.strictEqual(session.state.status, 'idle');
  });

  test('cancelQueued for an id already sent or unknown is a no-op', async () => {
    const { session } = makeSession();
    session.send('first');
    await settle();
    session.send('second');
    await settle();

    session.cancelQueued('nope');
    assert.strictEqual(session.state.queued?.[0]?.text, 'second');
  });

  test('the editor context captured at queue time is the one sent', async () => {
    const { provider, session } = makeSession();
    session.send('first');
    await settle();
    session.send('second', { path: 'a.ts', languageId: 'typescript' });
    await settle();

    provider.runs[0].emit({ kind: 'turn-end', reason: 'done' });
    await settle();

    assert.deepStrictEqual(provider.sent[1].context, {
      path: 'a.ts', languageId: 'typescript',
    });
  });

  test('each queued message keeps its own editor context, not the last one typed', async () => {
    const { provider, session } = makeSession();
    session.send('first');
    await settle();
    session.send('second', { path: 'a.ts', languageId: 'typescript' });
    session.send('third', { path: 'b.ts', languageId: 'typescript' });
    await settle();

    provider.runs[0].emit({ kind: 'turn-end', reason: 'done' });
    await settle();
    provider.runs[0].emit({ kind: 'turn-end', reason: 'done' });
    await settle();

    assert.deepStrictEqual(provider.sent.map((s) => s.context), [
      undefined,
      { path: 'a.ts', languageId: 'typescript' },
      { path: 'b.ts', languageId: 'typescript' },
    ]);
  });

  test('a queued message is not lost when the turn ends in an error', async () => {
    const { provider, session } = makeSession();
    session.send('first');
    await settle();
    session.send('second');
    await settle();

    provider.runs[0].emit({ kind: 'turn-end', reason: 'error', error: 'boom' });
    await settle();

    assert.strictEqual(session.state.status, 'error');
    assert.strictEqual(session.state.queued?.[0]?.text, 'second');
    assert.strictEqual(provider.sent.length, 1);
  });

  test('a queued message drains once a background task outlives turn-end', async () => {
    const { provider, session } = makeSession();
    session.send('first');
    await settle();

    provider.runs[0].emit({ kind: 'background-tasks-changed', taskIds: ['bg-1'] });
    await settle();
    provider.runs[0].emit({ kind: 'turn-end', reason: 'done' });
    await settle();

    // The foreground turn ended, but the background task keeps the session
    // out of idle, so a fresh send parks rather than forwards.
    session.send('second');
    await settle();
    assert.strictEqual(session.state.status, 'running');
    assert.strictEqual(provider.sent.length, 1);
    assert.strictEqual(session.state.queued?.[0]?.text, 'second');

    provider.runs[0].emit({ kind: 'background-tasks-changed', taskIds: [] });
    await settle();

    assert.deepStrictEqual(provider.sent.map((s) => s.text), ['first', 'second']);
    assert.strictEqual(session.state.queued, undefined);
    assert.strictEqual(session.state.status, 'running');
  });
});
