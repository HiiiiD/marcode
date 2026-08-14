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
import type {
  AgentEvent, AgentProvider, AgentRun, ModelInfo, StartOptions, ToolDecision, UsageWindow,
} from '../../providers/types';

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
  throwOnSetModel?: boolean;
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
      setModel: () => {
        if (this.opts.throwOnSetModel) { throw new Error('setModel failed'); }
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
    includeEditorContext: true,
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

class RecordingSink implements SessionSink {
  patches: { id: SessionId; patch: TranscriptPatch }[] = [];
  statuses: SessionStatus[] = [];
  changes = 0;
  servers: unknown[] = [];
  /**
   * Deviation from the brief: SessionSink.invocables is a *method*
   * (id, entries) => void, so a same-named array field cannot coexist on
   * this class and still satisfy the interface. Recorded as
   * `invocablesLog` instead; the assertions read the same shape
   * (Invocable[][]) the brief's `sink.invocables` would have.
   */
  invocablesLog: Invocable[][] = [];
  /** Recorded as (providerId, window) pairs — usage is keyed by provider. */
  usageLog: { providerId: string; window: UsageWindow }[] = [];
  patch(id: SessionId, patch: TranscriptPatch) { this.patches.push({ id, patch }); }
  status(_id: SessionId, status: SessionStatus) { this.statuses.push(status); }
  mcp(_id: SessionId, servers: unknown[]) { this.servers.push(servers); }
  changed() { this.changes++; }
  invocables(_id: SessionId, entries: Invocable[]) { this.invocablesLog.push(entries); }
  usageWindow(providerId: string, window: UsageWindow) {
    this.usageLog.push({ providerId, window });
  }
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

  function makeSession(script: (text: string) => AgentEvent[] = () => []) {
    const provider = new FakeProvider(script);
    const localSink = new RecordingSink();
    const session = new AgentSession(baseState(), provider, store, localSink);
    return { provider, sink: localSink, session };
  }

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

  test('an mcp-named permission event carries the bare name and the parsed server', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'permission', id: 'r1', name: 'mcp__github__create_pr', input: {} },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('open a pr');
    await settle();

    const snap = await session.snapshot();
    const perm = snap.items.find((i) => i.role === 'permission');
    assert.strictEqual((perm as { name: string }).name, 'create_pr');
    assert.strictEqual((perm as { mcpServer?: string }).mcpServer, 'github');
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

  test('setModel() updates state and notifies the sink', async () => {
    const provider = new FakeProvider(() => []);
    const session = new AgentSession(baseState(), provider, store, sink);

    session.setModel('fake-small');

    assert.strictEqual(session.state.model, 'fake-small');
    const snap = await session.snapshot();
    assert.strictEqual(snap.model, 'fake-small');
    await session.dispose();
  });

  test('setModel() to a model with no effort control drops the effort', async () => {
    const provider = new FakeProvider(() => []);
    const session = new AgentSession(baseState(), provider, store, sink);

    session.setModel('fake-small');

    assert.strictEqual(session.state.effort, undefined);
    assert.strictEqual((await session.snapshot()).effort, undefined);
    await session.dispose();
  });

  test('setModel() clamps an effort the new model does not offer to its default', async () => {
    const provider = new FakeProvider(() => []);
    const session = new AgentSession(
      { ...baseState(), model: 'fake-small', effort: 'max' }, provider, store, sink,
    );

    session.setModel('fake-large');

    assert.strictEqual(session.state.effort, 'medium', 'fake-large offers low/medium/high');
    await session.dispose();
  });

  test('setModel() before the first send pushes the reconciled effort to the run', async () => {
    // The provider builds its query on the first send(), from whatever effort
    // it was last told — so a pre-send reconciliation has to reach it, or the
    // query starts on an effort the chosen model cannot take.
    const provider = new FakeProvider(() => []);
    const session = new AgentSession(baseState(), provider, store, sink);

    session.setModel('fake-small');

    assert.deepStrictEqual(provider.efforts, [], 'no effort to send: fake-small has none');

    session.setModel('fake-large');
    assert.deepStrictEqual(provider.efforts, ['medium']);
    await session.dispose();
  });

  test('setModel() after the first send does not push effort at the running query', async () => {
    // The model change itself is already a no-op on a running query, so
    // applying its effort would change the effort of the *old* model.
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const session = new AgentSession(baseState(), provider, store, sink);

    session.send('go');
    await settle();
    session.setModel('fake-small');

    assert.strictEqual(session.state.effort, undefined, 'state still records the choice');
    assert.deepStrictEqual(provider.efforts, []);
    await session.dispose();
  });

  test('setModel() on a provider reporting no catalog keeps the current effort', async () => {
    const provider = new ThrowingProvider({});
    const session = new AgentSession(baseState(), provider, store, sink);

    session.setModel('mystery');

    assert.strictEqual(session.state.effort, 'medium');
    await session.dispose();
  });

  test('setModel() on a throwing provider does not throw and settles the session into error', async () => {
    const provider = new ThrowingProvider({ throwOnSetModel: true });
    const session = new AgentSession(baseState(), provider, store, sink);

    assert.doesNotThrow(() => session.setModel('haiku'));
    assert.strictEqual(session.state.status, 'error');
    const snap = await session.snapshot();
    const err = snap.items.find((i) => i.role === 'error');
    assert.strictEqual((err as { message: string }).message, 'setModel failed');
    await session.dispose();
  });

  test('an mcp-servers event reaches the sink and the snapshot', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'mcp-servers', servers: [
        { name: 'github', state: 'connected', toolCount: 12 },
        { name: 'stripe', state: 'failed', error: 'spawn ENOENT' },
      ] },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    assert.strictEqual(sink.servers.length, 1, 'one snapshot forwarded');
    const snap = await session.snapshot();
    assert.strictEqual(snap.mcpServers.length, 2);
    assert.strictEqual(snap.mcpServers[0].name, 'github');
    await session.dispose();
  });

  test('a later mcp-servers event replaces the previous snapshot wholesale', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'mcp-servers', servers: [{ name: 'github', state: 'pending' }] },
      { kind: 'mcp-servers', servers: [{ name: 'github', state: 'connected', toolCount: 12 }] },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const snap = await session.snapshot();
    assert.strictEqual(snap.mcpServers.length, 1);
    assert.strictEqual(snap.mcpServers[0].state, 'connected');
    assert.strictEqual(snap.mcpServers[0].toolCount, 12);
    await session.dispose();
  });

  test('an invocables event is reported to the sink', async () => {
    const { provider, sink } = makeSession();

    provider.runs[0].emit({ kind: 'invocables', entries: [{ name: 'init' }] });
    await settle();

    assert.deepStrictEqual(sink.invocablesLog, [[{ name: 'init' }]]);
  });

  test('setInvocables lands in the snapshot and replaces wholesale', async () => {
    const { session } = makeSession();

    session.setInvocables([{ name: 'a' }, { name: 'b' }]);
    session.setInvocables([{ name: 'c' }]);

    assert.deepStrictEqual((await session.snapshot()).invocables, [{ name: 'c' }]);
  });

  test('a session told nothing has no invocables in its snapshot', async () => {
    const { session } = makeSession();

    assert.strictEqual((await session.snapshot()).invocables, undefined);

  });
  test('send stores the context on the user item and forwards it to the run', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const session = new AgentSession(baseState(), provider, store, sink);
    const ctx = {
      path: 'src/a.ts',
      languageId: 'typescript',
      selection: { ranges: [{ startLine: 1, endLine: 2, text: 'x' }], truncated: false },
    };

    session.send('look at this', ctx);
    await settle();

    assert.deepStrictEqual(provider.sent[0], { text: 'look at this', context: ctx });
    const snapshot = await session.snapshot();
    const user = snapshot.items.find((i) => i.role === 'user');
    assert.ok(user && user.role === 'user');
    assert.deepStrictEqual(user.context, ctx);
    await session.dispose();
  });

  test('send without a context leaves the user item unchanged', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const session = new AgentSession(baseState(), provider, store, sink);

    session.send('plain');
    await settle();

    const snapshot = await session.snapshot();
    const user = snapshot.items.find((i) => i.role === 'user');
    assert.ok(user && user.role === 'user');
    // Persisted transcripts written before this feature have no `context`;
    // a send with none must produce exactly that shape, not `context: null`.
    assert.strictEqual('context' in user, false);
    await session.dispose();
  });

  test('setIncludeEditorContext flips the persisted flag', async () => {
    const session = new AgentSession(baseState(), new FakeProvider(() => []), store, sink);
    assert.strictEqual(session.state.includeEditorContext, true);
    session.setIncludeEditorContext(false);
    assert.strictEqual(session.state.includeEditorContext, false);
    await session.dispose();
  });

  test('turn-end refreshes contextPercent from the run breakdown', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }], {
      context: {
        systemPercent: 10, memoryPercent: 5, conversationPercent: 25, freePercent: 60,
        memoryFiles: [],
      },
    });
    const session = new AgentSession(baseState(), provider, store, sink);

    session.send('hello');
    await settle();

    assert.strictEqual(session.state.contextPercent, 40);
    await session.dispose();
  });

  test('a run without contextBreakdown leaves contextPercent undefined', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const session = new AgentSession(baseState(), provider, store, sink);

    session.send('hello');
    await settle();

    assert.strictEqual(session.state.contextPercent, undefined);
    await session.dispose();
  });

  test('a usage-window event reaches the sink under this session provider id', async () => {
    const { provider, sink: localSink, session } = makeSession();
    const window = { id: 'five-hour', label: 'Session (5h)', usedPercent: 62 };

    provider.runs[0].emit({ kind: 'usage-window', window });
    await settle();

    assert.deepStrictEqual(localSink.usageLog, [{ providerId: 'fake', window }]);
    await session.dispose();
  });
});
