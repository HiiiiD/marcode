import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentSession, type SessionSink } from '../../host/agent-session';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type {
  AgentEvent, AgentProvider, AgentRun, ModelInfo, StartOptions, ToolDecision,
} from '../../providers/types';
import type { SessionId, SessionState, SessionStatus, TranscriptPatch } from '../../protocol/messages';

/** Minimal pushable async-iterable, mirroring FakeProvider's internal channel. */
class EventChannel implements AsyncIterable<AgentEvent> {
  private queue: AgentEvent[] = [];
  private waiting: ((v: IteratorResult<AgentEvent>) => void) | undefined;
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) { return; }
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: (): Promise<IteratorResult<AgentEvent>> => {
        const next = this.queue.shift();
        if (next) { return Promise.resolve({ value: next, done: false }); }
        if (this.closed) { return Promise.resolve({ value: undefined, done: true }); }
        return new Promise((resolve) => { this.waiting = resolve; });
      },
    };
  }
}

interface ThrowingProviderOptions {
  throwOnSend?: boolean;
  throwOnRespond?: boolean;
  throwOnInterrupt?: boolean;
  throwOnSetEffort?: boolean;
  throwOnSetPermissionMode?: boolean;
  script?: (text: string) => AgentEvent[];
}

/**
 * A provider whose AgentRun methods throw/reject synchronously, to exercise
 * the "errors are state, never exceptions" contract on AgentSession's
 * public API without depending on FakeProvider's scripted-event model.
 */
class ThrowingProvider implements AgentProvider {
  readonly id = 'throwing';
  readonly displayName = 'Throwing';

  constructor(private readonly opts: ThrowingProviderOptions) {}

  listModels(): ModelInfo[] { return []; }

  start(_opts: StartOptions): AgentRun {
    const channel = new EventChannel();
    return {
      events: channel,
      send: (text: string) => {
        if (this.opts.throwOnSend) { throw new Error('send failed'); }
        for (const ev of this.opts.script?.(text) ?? []) { channel.push(ev); }
      },
      respondToTool: (_id: string, _decision: ToolDecision) => {
        if (this.opts.throwOnRespond) { throw new Error('respond failed'); }
      },
      setEffort: () => {
        if (this.opts.throwOnSetEffort) { throw new Error('setEffort failed'); }
      },
      setPermissionMode: () => {
        if (this.opts.throwOnSetPermissionMode) { throw new Error('setPermissionMode failed'); }
      },
      interrupt: async () => {
        if (this.opts.throwOnInterrupt) { throw new Error('interrupt failed'); }
      },
      dispose: async () => { channel.close(); },
    };
  }
}

function baseState(): SessionState {
  return {
    id: 's1', providerId: 'fake', model: 'fake-large', effort: 'medium',
    title: 'Untitled', cwd: '/tmp', status: 'idle', permissionMode: 'default',
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

class RecordingSink implements SessionSink {
  patches: { id: SessionId; patch: TranscriptPatch }[] = [];
  statuses: SessionStatus[] = [];
  changes = 0;
  patch(id: SessionId, patch: TranscriptPatch) { this.patches.push({ id, patch }); }
  status(_id: SessionId, status: SessionStatus) { this.statuses.push(status); }
  changed() { this.changes++; }
}

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('AgentSession', () => {
  let dir: string;
  let store: TranscriptStore;
  let sink: RecordingSink;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-session-'));
    store = new TranscriptStore(dir);
    sink = new RecordingSink();
  });

  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('coalesces text deltas into one assistant item', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'text', delta: 'Hel' },
      { kind: 'text', delta: 'lo' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('hi');
    await settle();

    const snap = await session.snapshot();
    const assistant = snap.items.filter((i) => i.role === 'assistant');
    assert.strictEqual(assistant.length, 1);
    assert.strictEqual((assistant[0] as { text: string }).text, 'Hello');

    const deltas = sink.patches.filter((p) => p.patch.op === 'delta');
    assert.strictEqual(deltas.length, 2, 'each delta is streamed separately');
    await session.dispose();
  });

  test('appends the user message and derives the title from it', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('Refactor the auth module');
    await settle();

    assert.strictEqual(session.state.title, 'Refactor the auth module');
    const snap = await session.snapshot();
    assert.strictEqual(snap.items[0].role, 'user');
    await session.dispose();
  });

  test('a permission event parks the session and respondToPermission settles it', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'permission', id: 'r1', name: 'Bash', input: { command: 'ls' } },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('list files');
    await settle();

    assert.strictEqual(session.state.status, 'awaiting-approval');
    let snap = await session.snapshot();
    assert.strictEqual(snap.pending.length, 1);
    assert.strictEqual(snap.pending[0].requestId, 'r1');

    session.respondToPermission('r1', { allow: true });
    await settle();

    assert.deepStrictEqual(provider.decisions.get('r1'), { allow: true });
    snap = await session.snapshot();
    assert.strictEqual(snap.pending.length, 0);
    const perm = snap.items.find((i) => i.role === 'permission');
    assert.strictEqual((perm as { state: string }).state, 'allowed');
    await session.dispose();
  });

  test('tool-start then tool-end replaces the tool item in place', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 't1', name: 'Read', input: { path: 'a.ts' } },
      { kind: 'tool-end', id: 't1', ok: true, output: 'contents' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('read a.ts');
    await settle();

    const snap = await session.snapshot();
    const tools = snap.items.filter((i) => i.role === 'tool');
    assert.strictEqual(tools.length, 1);
    assert.strictEqual((tools[0] as { state: string }).state, 'ok');
    assert.ok(sink.patches.some((p) => p.patch.op === 'replace'));
    await session.dispose();
  });

  test('turn-end with error moves the session to error and appends an error item', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'turn-end', reason: 'error', error: 'spawn failed' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    assert.strictEqual(session.state.status, 'error');
    const snap = await session.snapshot();
    const err = snap.items.find((i) => i.role === 'error');
    assert.strictEqual((err as { message: string }).message, 'spawn failed');
    await session.dispose();
  });

  test('dispose denies outstanding permissions so the provider can unwind', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'permission', id: 'r1', name: 'Bash', input: {} },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    await session.dispose();
    assert.deepStrictEqual(provider.decisions.get('r1'), {
      allow: false, reason: 'Session closed',
    });
  });

  test('records the resume token from the session event', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('hi');
    await settle();

    assert.strictEqual(session.state.resumeToken, 'fake-session-1');
    await session.dispose();
  });

  test('send() on a throwing provider settles the session into error instead of throwing', async () => {
    const provider = new ThrowingProvider({ throwOnSend: true });
    const session = new AgentSession(baseState(), provider, store, sink);
    assert.doesNotThrow(() => session.send('go'));
    await settle();

    assert.strictEqual(session.state.status, 'error');
    const snap = await session.snapshot();
    const err = snap.items.find((i) => i.role === 'error');
    assert.strictEqual((err as { message: string }).message, 'send failed');
    await session.dispose();
  });

  test('respondToPermission() on a throwing provider denies the item and clears it from pending', async () => {
    const provider = new ThrowingProvider({
      throwOnRespond: true,
      script: () => [{ kind: 'permission', id: 'r1', name: 'Bash', input: {} }],
    });
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('list files');
    await settle();
    assert.strictEqual(session.state.status, 'awaiting-approval');

    assert.doesNotThrow(() => session.respondToPermission('r1', { allow: true }));
    await settle();

    // The provider rejected the decision: the session moves to error, the
    // request is gone from pending, and the transcript item is settled as
    // denied rather than being stuck at 'pending' forever (regression for
    // the finding where the item disappeared from `pending` while staying
    // 'pending' on disk with no way for the user to retry).
    assert.strictEqual(session.state.status, 'error');
    const snap = await session.snapshot();
    assert.strictEqual(snap.pending.length, 0);
    const perm = snap.items.find((i) => i.role === 'permission');
    assert.strictEqual((perm as { state: string }).state, 'denied');
    assert.strictEqual((perm as { reason?: string }).reason, 'respond failed');
    await session.dispose();
  });

  test('interrupt() on a throwing provider does not reject and settles the session into error', async () => {
    const provider = new ThrowingProvider({ throwOnInterrupt: true });
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    await assert.doesNotReject(() => session.interrupt());
    await settle();

    assert.strictEqual(session.state.status, 'error');
    const snap = await session.snapshot();
    const err = snap.items.find((i) => i.role === 'error');
    assert.strictEqual((err as { message: string }).message, 'interrupt failed');
    await session.dispose();
  });

  test('setEffort() on a throwing provider does not throw and settles the session into error', async () => {
    const provider = new ThrowingProvider({ throwOnSetEffort: true });
    const session = new AgentSession(baseState(), provider, store, sink);

    assert.doesNotThrow(() => session.setEffort('high'));
    assert.strictEqual(session.state.status, 'error');
    const snap = await session.snapshot();
    const err = snap.items.find((i) => i.role === 'error');
    assert.strictEqual((err as { message: string }).message, 'setEffort failed');
    await session.dispose();
  });

  test('setPermissionMode() on a throwing provider does not throw and settles the session into error', async () => {
    const provider = new ThrowingProvider({ throwOnSetPermissionMode: true });
    const session = new AgentSession(baseState(), provider, store, sink);

    assert.doesNotThrow(() => session.setPermissionMode('bypass'));
    assert.strictEqual(session.state.status, 'error');
    const snap = await session.snapshot();
    const err = snap.items.find((i) => i.role === 'error');
    assert.strictEqual((err as { message: string }).message, 'setPermissionMode failed');
    await session.dispose();
  });
});
