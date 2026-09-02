import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentSession, type SessionSink } from '../../host/agent-session';
import { TranscriptStore } from '../../host/transcript-store';
import type {
  Attachment, Invocable, SessionId, SessionState, SessionStatus, TranscriptPatch,
} from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type {
  AgentEvent, AgentProvider, AgentRun, ModelInfo, PermissionModeInfo, StartOptions, ThreadScope,
  ToolDecision, UsageWindow,
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
  readonly threadScope: ThreadScope = 'cwd';

  constructor(private readonly opts: ThrowingProviderOptions) {}

  listModels(): ModelInfo[] { return []; }

  listPermissionModes(): PermissionModeInfo[] {
    return [
      { id: 'default' }, { id: 'acceptEdits' }, { id: 'auto' },
      { id: 'plan' }, { id: 'dontAsk' }, { id: 'bypass' },
    ];
  }

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
      respondToQuestion: () => { /* not exercised by these tests */ },
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
    resumeTokens: {},
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
  /** Every whole-set pull reported up, in order. */
  usageWindowSets: { providerId: string; windows: UsageWindow[] | undefined }[] = [];
  /** Every pending-set report, in order — including the empty one a send leaves behind. */
  attachmentSets: Attachment[][] = [];
  pendingAttachments(_id: SessionId, pending: Attachment[]) { this.attachmentSets.push(pending); }
  patch(id: SessionId, patch: TranscriptPatch) { this.patches.push({ id, patch }); }
  status(_id: SessionId, status: SessionStatus) { this.statuses.push(status); }
  mcp(_id: SessionId, servers: unknown[]) { this.servers.push(servers); }
  changed() { this.changes++; }
  invocables(_id: SessionId, entries: Invocable[]) { this.invocablesLog.push(entries); }
  usageWindows(providerId: string, windows: UsageWindow[] | undefined) {
    this.usageWindowSets.push({ providerId, windows });
  }
  /** Every shell-profile report, in order — one entry per call, no dedupe here. */
  shellNoiseLog: string[] = [];
  shellNoise(profile: string) { this.shellNoiseLog.push(profile); }
}

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

/**
 * Builds a session against its own scratch transcript directory, so this
 * helper is self-contained enough to be shared across test files (see
 * `agent-session-attachments.test.ts`) rather than needing the suite's
 * shared `store`/`sink` fixtures.
 */
export async function makeSession(script: (text: string) => AgentEvent[] = () => []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-session-'));
  const store = new TranscriptStore(dir);
  const provider = new FakeProvider(script);
  const sink = new RecordingSink();
  const session = new AgentSession(baseState(), provider, store, sink);
  // `run` is the provider, not `provider.runs[0]`: `.sent` — the (text,
  // context, attachments) triples a session's sends produced — lives on the
  // provider, since that is what FakeProvider records onto.
  return { provider, sink, session, run: provider };
}

suite('AgentSession', () => {
  let dir: string;
  let store: TranscriptStore;
  let sink: RecordingSink;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-session-'));
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

  test('send() with a from sender appends a user item carrying it', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('hi from A', undefined, undefined, undefined, { sessionId: 's-a', name: 'a' });
    await settle();

    const snap = await session.snapshot();
    const item = snap.items.find((i) => i.role === 'user' && i.text === 'hi from A');
    assert.strictEqual(item?.role === 'user' && item.from?.name, 'a');
    await session.dispose();
  });

  test('send() with no from sender omits the field entirely', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('typed by human');
    await settle();

    const snap = await session.snapshot();
    const item = snap.items.find((i) => i.role === 'user' && i.text === 'typed by human');
    assert.strictEqual(item?.role === 'user' && 'from' in item, false);
    await session.dispose();
  });

  test('a permission event parks the session and respondToPermission settles it', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'permission', id: 'r1', tool: { kind: 'command', label: 'Bash', command: 'ls' } },
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

  // Splitting an `mcp__<server>__<tool>` name is now the provider
  // classifier's job (see `parseMcpName` in providers/canonical/tool-call.ts
  // and each provider's own map-tools.ts), not AgentSession's — the host no
  // longer parses tool names at all. This exercises the equivalent behavior
  // one layer up: a `permission` event already carrying a classified `mcp`
  // call is persisted on the item exactly as the provider built it.
  test('an mcp-classified permission event is persisted on the item as the provider built it', async () => {
    const mcp = { kind: 'mcp' as const, label: 'create_pr', server: 'github', tool: 'create_pr' };
    const provider = new FakeProvider(() => [
      { kind: 'permission', id: 'r1', tool: mcp },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('open a pr');
    await settle();

    const snap = await session.snapshot();
    const perm = snap.items.find((i) => i.role === 'permission');
    assert.deepStrictEqual((perm as { tool: unknown }).tool, mcp);
    await session.dispose();
  });

  test('a tool item carries the canonical call the provider sent', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 't1', tool: { kind: 'command', label: 'Bash', command: 'ls' } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('list files');
    await settle();

    const snap = await session.snapshot();
    const item = snap.items.find((i) => i.role === 'tool');
    assert.strictEqual(item?.role === 'tool' && item.tool.kind, 'command');
    await session.dispose();
  });

  test('tool-start then tool-end replaces the tool item in place', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 't1', tool: { kind: 'file-read', label: 'Read', path: 'a.ts' } },
      { kind: 'tool-end', id: 't1', ok: true, output: { kind: 'text', text: 'contents' } },
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

  test('a tool-end that carries a tool revises the call the card renders', async () => {
    // Codex's `webSearch` item starts with an empty `query` and only carries
    // the real one on completion, so a provider must be able to correct the
    // arguments it reported at start. Captured live from codex-cli 0.147.0:
    // item/started `{query:''}`, item/completed `{query:'site:nodejs.org …'}`.
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 't1', tool: { kind: 'web', label: 'Web search', query: '' } },
      {
        kind: 'tool-end', id: 't1', ok: true, output: { kind: 'text', text: 'results' },
        tool: { kind: 'web', label: 'Web search', query: 'node lts' },
      },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('search');
    await settle();

    const snap = await session.snapshot();
    const tool = snap.items.find((i) => i.role === 'tool');
    assert.deepStrictEqual(
      (tool as { tool: unknown }).tool,
      { kind: 'web', label: 'Web search', query: 'node lts' },
    );
    await session.dispose();
  });

  test('a tool-end without a tool keeps the call from tool-start', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 't1', tool: { kind: 'file-read', label: 'Read', path: 'a.ts' } },
      { kind: 'tool-end', id: 't1', ok: true, output: { kind: 'text', text: 'contents' } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('read');
    await settle();

    const snap = await session.snapshot();
    const tool = snap.items.find((i) => i.role === 'tool');
    assert.deepStrictEqual(
      (tool as { tool: unknown }).tool,
      { kind: 'file-read', label: 'Read', path: 'a.ts' },
    );
    await session.dispose();
  });

  test('turn-end settles a tool call whose tool-end never arrived', async () => {
    // Measured against codex-cli 0.147.0: a provider that drops a `tool-end`
    // — a crash, an interrupt, a notification the adapter did not recognize
    // — used to leave the card spinning "Running…" forever, with the status
    // dot already back to idle.
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 't1', tool: { kind: 'command', label: 'Shell', command: 'ls' } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('list files');
    await settle();

    const snap = await session.snapshot();
    const tool = snap.items.find((i) => i.role === 'tool');
    assert.strictEqual((tool as { state: string }).state, 'error');
    assert.deepStrictEqual(
      (tool as { output?: unknown }).output,
      { kind: 'text', text: 'The agent ended this turn without reporting a result.' },
    );
    await session.dispose();
  });

  test('turn-end leaves an unsettled tool call its own output when it has one', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 't1', tool: { kind: 'command', label: 'Shell', command: 'ls' } },
      { kind: 'tool-end', id: 't1', ok: true, output: { kind: 'text', text: 'a.ts' } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('list files');
    await settle();

    const snap = await session.snapshot();
    const tool = snap.items.find((i) => i.role === 'tool');
    assert.strictEqual((tool as { state: string }).state, 'ok');
    assert.deepStrictEqual(
      (tool as { output?: unknown }).output,
      { kind: 'text', text: 'a.ts' },
    );
    await session.dispose();
  });

  test('turn-end settles an unsettled child inside its parent', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 'p1', tool: { kind: 'other', label: 'Task', raw: {} } },
      {
        kind: 'tool-start', id: 'c1', parentId: 'p1',
        tool: { kind: 'command', label: 'Shell', command: 'ls' },
      },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('go');
    await settle();

    const snap = await session.snapshot();
    const parent = snap.items.find((i) => i.role === 'tool');
    assert.strictEqual((parent as { state: string }).state, 'error');
    const children = (parent as { children?: { state?: string }[] }).children ?? [];
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].state, 'error');
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
      { kind: 'permission', id: 'r1', tool: { kind: 'command', label: 'Bash', command: 'ls' } },
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

    assert.strictEqual(session.state.resumeTokens['fake:/tmp'], 'fake-session-1');
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
      script: () => [{
        kind: 'permission', id: 'r1', tool: { kind: 'command', label: 'Bash', command: 'ls' },
      }],
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

  test('setModel() after the first send pushes the reconciled effort too', async () => {
    // The model change retargets the live query, so its effort has to travel
    // with it: leaving the old level in place runs the new model at a level it
    // may not even offer.
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }]);
    const session = new AgentSession(
      { ...baseState(), model: 'fake-small', effort: undefined }, provider, store, sink,
    );

    session.send('go');
    await settle();
    session.setModel('fake-large');

    assert.strictEqual(session.state.effort, 'medium');
    assert.deepStrictEqual(provider.efforts, ['medium']);
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

  test('setModel() appends a switch item naming the new model', async () => {
    const provider = new FakeProvider(() => []);
    const session = new AgentSession(baseState(), provider, store, sink);

    session.setModel('fake-small');

    const snap = await session.snapshot();
    const sw = snap.items.find((i) => i.role === 'switch');
    assert.strictEqual((sw as { kind: string }).kind, 'model');
    assert.strictEqual((sw as { text: string }).text, 'Switched model to Fake Small');
    await session.dispose();
  });

  test('setModel() to the model already in use appends no switch item', async () => {
    const provider = new FakeProvider(() => []);
    const session = new AgentSession(baseState(), provider, store, sink);

    session.setModel('fake-large');

    const snap = await session.snapshot();
    assert.strictEqual(snap.items.some((i) => i.role === 'switch'), false);
    await session.dispose();
  });

  test('setModel() implicitly reconciling effort appends only the model switch line', async () => {
    const provider = new FakeProvider(() => []);
    const session = new AgentSession(
      { ...baseState(), model: 'fake-small', effort: 'max' }, provider, store, sink,
    );

    session.setModel('fake-large');

    const snap = await session.snapshot();
    const switches = snap.items.filter((i) => i.role === 'switch');
    assert.strictEqual(switches.length, 1);
    await session.dispose();
  });

  test('setModel() on a throwing provider appends no switch item', async () => {
    const provider = new ThrowingProvider({ throwOnSetModel: true });
    const session = new AgentSession(baseState(), provider, store, sink);

    session.setModel('haiku');

    const snap = await session.snapshot();
    assert.strictEqual(snap.items.some((i) => i.role === 'switch'), false);
    await session.dispose();
  });

  test('setEffort() appends a switch item naming the new level', async () => {
    const provider = new FakeProvider(() => []);
    const session = new AgentSession(baseState(), provider, store, sink);

    session.setEffort('high');

    const snap = await session.snapshot();
    const sw = snap.items.find((i) => i.role === 'switch');
    assert.strictEqual((sw as { kind: string }).kind, 'effort');
    assert.strictEqual((sw as { text: string }).text, 'Switched effort to high');
    await session.dispose();
  });

  test('setEffort() to the level already in use appends no switch item', async () => {
    const provider = new FakeProvider(() => []);
    const session = new AgentSession(baseState(), provider, store, sink);

    session.setEffort('medium');

    const snap = await session.snapshot();
    assert.strictEqual(snap.items.some((i) => i.role === 'switch'), false);
    await session.dispose();
  });

  test('setEffort() on a throwing provider appends no switch item', async () => {
    const provider = new ThrowingProvider({ throwOnSetEffort: true });
    const session = new AgentSession(baseState(), provider, store, sink);

    session.setEffort('high');

    const snap = await session.snapshot();
    assert.strictEqual(snap.items.some((i) => i.role === 'switch'), false);
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
    const { provider, sink } = await makeSession();

    provider.runs[0].emit({ kind: 'invocables', entries: [{ name: 'init' }] });
    await settle();

    assert.deepStrictEqual(sink.invocablesLog, [[{ name: 'init' }]]);
  });

  test('setInvocables lands in the snapshot and replaces wholesale', async () => {
    const { session } = await makeSession();

    session.setInvocables([{ name: 'a' }, { name: 'b' }]);
    session.setInvocables([{ name: 'c' }]);

    assert.deepStrictEqual((await session.snapshot()).invocables, [{ name: 'c' }]);
  });

  test('a session told nothing has no invocables in its snapshot', async () => {
    const { session } = await makeSession();

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

    assert.deepStrictEqual(
      provider.sent[0], { text: 'look at this', context: ctx, attachments: undefined, runIndex: 0 },
    );
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

  test('turn-end remembers the whole breakdown, not only the percentage', async () => {
    // A session restored after a window reload has a fresh run with no live
    // query behind it, so the breakdown can only come from what the last
    // turn recorded — see SessionManager.contextBreakdown's cached path.
    const reported = {
      systemPercent: 10, memoryPercent: 5, conversationPercent: 25, freePercent: 60,
      memoryFiles: [{ path: '/repo/CLAUDE.md', percent: 5 }],
    };
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }], {
      context: reported,
    });
    const session = new AgentSession(baseState(), provider, store, sink);

    session.send('hello');
    await settle();

    assert.deepStrictEqual(session.state.lastContext, reported);
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

  test('serving a breakdown refreshes contextPercent from the same measurement', async () => {
    const provider = new FakeProvider(undefined, {
      context: {
        systemPercent: 12, memoryPercent: 4, conversationPercent: 27, freePercent: 57,
        memoryFiles: [],
      },
    });
    const session = new AgentSession(baseState(), provider, store, sink);
    await session.contextBreakdown();
    assert.strictEqual(session.state.contextPercent, 43);
    assert.ok(sink.changes > 0);
    await session.dispose();
  });

  test('a usage-stale event pulls the window set and reports it up', async () => {
    const windows = [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 55 }];
    const provider = new FakeProvider(() => [], { windows });
    const localSink = new RecordingSink();
    const session = new AgentSession(baseState(), provider, store, localSink);

    provider.runs[0].emit({ kind: 'usage-stale' });
    await settle();

    assert.deepStrictEqual(localSink.usageWindowSets, [{ providerId: 'fake', windows }]);
    await session.dispose();
  });

  test('turn end pulls the window set', async () => {
    const windows = [{ id: 'seven-day', label: 'Week', usedPercent: 7 }];
    const provider = new FakeProvider(() => [], { windows });
    const localSink = new RecordingSink();
    const session = new AgentSession(baseState(), provider, store, localSink);

    provider.runs[0].emit({ kind: 'turn-end', reason: 'done' });
    await settle();

    assert.deepStrictEqual(localSink.usageWindowSets, [{ providerId: 'fake', windows }]);
    await session.dispose();
  });

  test('a failing usage pull does not fail the turn', async () => {
    const provider = new FakeProvider(() => []);
    const localSink = new RecordingSink();
    const session = new AgentSession(baseState(), provider, store, localSink);
    provider.runs[0].usageWindows = async () => { throw new Error('nope'); };

    provider.runs[0].emit({ kind: 'turn-end', reason: 'done' });
    await settle();

    // The strip is decoration over a live conversation. An unavailable pull is
    // a degraded strip, never an error item and never a status change.
    assert.strictEqual(session.state.status, 'idle');
    assert.deepStrictEqual(localSink.usageWindowSets, []);
    await session.dispose();
  });

  test('a provider that cannot report usage is simply never reported for', async () => {
    const provider = new FakeProvider(() => []);
    const localSink = new RecordingSink();
    const session = new AgentSession(baseState(), provider, store, localSink);
    provider.runs[0].usageWindows = undefined;

    provider.runs[0].emit({ kind: 'usage-stale' });
    await settle();

    assert.deepStrictEqual(localSink.usageWindowSets, []);
    await session.dispose();
  });

  const NOISY_OUTPUT = 'Set-PSReadLineOption: '
    + 'C:\\Users\\dev\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1:23\n'
    + 'Handle is invalid.\n';

  function shellEnd(id: string, text: string): AgentEvent[] {
    return [
      { kind: 'tool-start', id, tool: { kind: 'command', label: 'Shell', command: 'ls' } },
      { kind: 'tool-end', id, ok: true, output: { kind: 'text', text } },
    ];
  }

  test('a command whose output carries a profile failure reports the profile up', async () => {
    const provider = new FakeProvider(() => [
      ...shellEnd('t1', NOISY_OUTPUT),
      { kind: 'turn-end', reason: 'done' },
    ]);
    const localSink = new RecordingSink();
    const session = new AgentSession(baseState(), provider, store, localSink);
    session.send('ls');
    await settle();

    assert.deepStrictEqual(
      localSink.shellNoiseLog,
      ['C:\\Users\\dev\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1'],
    );
    await session.dispose();
  });

  test('a broken profile is reported once, not once per command', async () => {
    // Every command in the turn carries the same frame — the profile loads
    // for each one. Reporting per command would be a warning per shell call.
    const provider = new FakeProvider(() => [
      ...shellEnd('t1', NOISY_OUTPUT),
      ...shellEnd('t2', NOISY_OUTPUT),
      ...shellEnd('t3', NOISY_OUTPUT),
      { kind: 'turn-end', reason: 'done' },
    ]);
    const localSink = new RecordingSink();
    const session = new AgentSession(baseState(), provider, store, localSink);
    session.send('ls');
    await settle();

    assert.strictEqual(localSink.shellNoiseLog.length, 1);
    await session.dispose();
  });

  test('a clean command reports nothing, and neither does a non-command tool', async () => {
    const provider = new FakeProvider(() => [
      ...shellEnd('t1', 'src\ndist\n'),
      {
        kind: 'tool-start', id: 't2',
        tool: { kind: 'file-read', label: 'Read', path: 'profile.ps1' },
      },
      { kind: 'tool-end', id: 't2', ok: true, output: { kind: 'text', text: NOISY_OUTPUT } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const localSink = new RecordingSink();
    const session = new AgentSession(baseState(), provider, store, localSink);
    session.send('ls');
    await settle();

    // Reading a profile that happens to contain an old error frame is not the
    // same claim as a shell that just loaded a broken one.
    assert.deepStrictEqual(localSink.shellNoiseLog, []);
    await session.dispose();
  });

  test('a sink with no shellNoise handler is not an error', async () => {
    // The hook is optional on SessionSink so existing sinks stay valid.
    const provider = new FakeProvider(() => [
      ...shellEnd('t1', NOISY_OUTPUT),
      { kind: 'turn-end', reason: 'done' },
    ]);
    const bare: SessionSink = {
      patch: () => {}, status: () => {}, mcp: () => {}, changed: () => {},
      invocables: () => {}, usageWindows: () => {},
    };
    const session = new AgentSession(baseState(), provider, store, bare);
    session.send('ls');
    await settle();

    const snap = await session.snapshot();
    assert.strictEqual(snap.items.filter((i) => i.role === 'tool').length, 1);
    await session.dispose();
  });
});

suite('AgentSession background tasks', () => {
  let dir: string;
  let store: TranscriptStore;
  let sink: RecordingSink;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-session-'));
    store = new TranscriptStore(dir);
    sink = new RecordingSink();
  });

  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('turn-end does not go idle while a background task is still live', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'background-tasks-changed', taskIds: ['bg-1'] },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('kick off a background task');
    await settle();

    assert.strictEqual(
      session.state.status, 'running',
      'a live background task must keep the session out of idle, so Stop stays reachable',
    );
    await session.dispose();
  });

  test('the session goes idle once the background-tasks-changed event reports the set drained', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'background-tasks-changed', taskIds: ['bg-1'] },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('kick off a background task');
    await settle();
    assert.strictEqual(session.state.status, 'running');

    // The task settles after the foreground turn already ended — exactly
    // the ordering `task_notification`/`background_tasks_changed` reports.
    provider.runs[0].emit({ kind: 'background-tasks-changed', taskIds: [] });
    await settle();

    assert.strictEqual(session.state.status, 'idle');
    await session.dispose();
  });

  test('a background task that starts and drains mid-turn does not end the turn early', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'background-tasks-changed', taskIds: ['bg-1'] },
      { kind: 'background-tasks-changed', taskIds: [] },
      { kind: 'text', delta: 'still working' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('kick off a short background task');
    await settle();

    assert.strictEqual(session.state.status, 'idle', 'the turn itself has since ended normally');
    const snap = await session.snapshot();
    const assistant = snap.items.find((i) => i.role === 'assistant');
    assert.strictEqual((assistant as { text: string } | undefined)?.text, 'still working');
    await session.dispose();
  });
});

const QUESTION_SPEC = {
  id: 'q1', header: 'H', question: 'Q?', multiSelect: false,
  allowOther: true, secret: false,
  options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
};

suite('AgentSession questions', () => {
  let dir: string;
  let store: TranscriptStore;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-session-questions-'));
    store = new TranscriptStore(dir);
  });

  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  function sessionWith() {
    const provider = new FakeProvider();
    const sink = new RecordingSink();
    const session = new AgentSession(baseState(), provider, store, sink);
    return { session, provider, sink };
  }

  test('a question event appends a pending item and records the request', async () => {
    const { session, provider } = sessionWith();
    provider.runs[0].emit({ kind: 'question', id: 'r1', blocking: true, questions: [QUESTION_SPEC] });
    await settle();

    const state = await session.snapshot();
    const item = state.items.at(-1);
    assert.strictEqual(item?.role, 'question');
    assert.strictEqual((item as { state: string }).state, 'pending');
    assert.strictEqual(state.pendingQuestions.length, 1);
    assert.strictEqual(state.pendingQuestions[0].requestId, 'r1');
    await session.dispose();
  });

  test('answering replaces the item and calls the provider once', async () => {
    const { session, provider } = sessionWith();
    provider.runs[0].emit({ kind: 'question', id: 'r1', blocking: true, questions: [QUESTION_SPEC] });
    await settle();

    session.answerQuestion('r1', { q1: ['A'] });
    session.answerQuestion('r1', { q1: ['B'] });
    await settle();

    assert.deepStrictEqual(provider.answered, [['r1', { q1: ['A'] }]]);
    const state = await session.snapshot();
    assert.strictEqual((state.items.at(-1) as { state: string }).state, 'answered');
    assert.strictEqual(state.pendingQuestions.length, 0);
    await session.dispose();
  });

  test('a cancellation marks the card cancelled', async () => {
    const { session, provider } = sessionWith();
    provider.runs[0].emit({ kind: 'question', id: 'r1', blocking: true, questions: [QUESTION_SPEC] });
    await settle();
    provider.runs[0].emit({ kind: 'request-cancelled', id: 'r1' });
    await settle();

    const state = await session.snapshot();
    assert.strictEqual((state.items.at(-1) as { state: string }).state, 'cancelled');
    assert.strictEqual(state.pendingQuestions.length, 0);
    await session.dispose();
  });

  test('answering a question while a permission is still pending keeps the session waiting', async () => {
    const { session, provider } = sessionWith();
    provider.runs[0].emit({
      kind: 'permission', id: 'p1', tool: { kind: 'command', label: 'Bash', command: 'ls' },
    });
    provider.runs[0].emit({ kind: 'question', id: 'r1', blocking: true, questions: [QUESTION_SPEC] });
    await settle();
    assert.strictEqual(session.state.status, 'awaiting-approval');

    session.answerQuestion('r1', { q1: ['A'] });
    await settle();

    assert.strictEqual(session.state.status, 'awaiting-approval', 'the permission is still pending');
    assert.strictEqual((await session.snapshot()).pending.length, 1);
    await session.dispose();
  });

  test('resolving a pending permission while a question is still pending keeps the session waiting', async () => {
    const { session, provider } = sessionWith();
    provider.runs[0].emit({
      kind: 'permission', id: 'p1', tool: { kind: 'command', label: 'Bash', command: 'ls' },
    });
    provider.runs[0].emit({ kind: 'question', id: 'r1', blocking: true, questions: [QUESTION_SPEC] });
    await settle();

    session.respondToPermission('p1', { allow: true });
    await settle();

    assert.strictEqual(session.state.status, 'awaiting-approval', 'the question is still pending');
    assert.strictEqual((await session.snapshot()).pendingQuestions.length, 1);
    await session.dispose();
  });

  test('a cancelled permission settles denied, and a later decision on it is a no-op', async () => {
    const { session, provider } = sessionWith();
    provider.runs[0].emit({
      kind: 'permission', id: 'p1', tool: { kind: 'command', label: 'Bash', command: 'ls' },
    });
    await settle();
    assert.strictEqual(session.state.status, 'awaiting-approval');

    provider.runs[0].emit({ kind: 'request-cancelled', id: 'p1' });
    await settle();

    const state = await session.snapshot();
    const perm = state.items.find((i) => i.role === 'permission');
    assert.strictEqual((perm as { state: string }).state, 'denied');
    assert.strictEqual((perm as { reason?: string }).reason, 'Turn cancelled');
    assert.strictEqual(state.pending.length, 0, 'no longer parked');
    assert.strictEqual(session.state.status, 'running', 'nothing else pending');

    session.respondToPermission('p1', { allow: true });
    await settle();

    assert.strictEqual(
      provider.decisions.has('p1'), false,
      'the provider never sees a decision for an already-cancelled request',
    );
    const after = await session.snapshot();
    const perm2 = after.items.find((i) => i.role === 'permission');
    assert.strictEqual((perm2 as { state: string }).state, 'denied', 'the click is a no-op');
    await session.dispose();
  });

  test("a secret answer's value never reaches the transcript file", async () => {
    const { session, provider } = sessionWith();
    const SECRET_SPEC = {
      id: 'q1', header: 'Token', question: 'API token?', multiSelect: false,
      allowOther: true, secret: true,
    };
    provider.runs[0].emit({ kind: 'question', id: 'r1', blocking: true, questions: [SECRET_SPEC] });
    await settle();

    session.answerQuestion('r1', { q1: ['sk-super-secret-value'] });
    await settle();
    await session.snapshot(); // forces a flush

    const jsonl = await fs.readFile(path.join(dir, 'sessions', 's1.jsonl'), 'utf8');
    assert.strictEqual(jsonl.includes('sk-super-secret-value'), false);
    assert.strictEqual(jsonl.includes('"state":"answered"'), true);
    await session.dispose();
  });

  test('a non-secret answer is persisted in full', async () => {
    const { session, provider } = sessionWith();
    provider.runs[0].emit({ kind: 'question', id: 'r1', blocking: true, questions: [QUESTION_SPEC] });
    await settle();

    session.answerQuestion('r1', { q1: ['A'] });
    await settle();
    await session.snapshot(); // forces a flush

    const jsonl = await fs.readFile(path.join(dir, 'sessions', 's1.jsonl'), 'utf8');
    assert.strictEqual(jsonl.includes('"q1":["A"]'), true);
    await session.dispose();
  });

  test('answering the last parked question lets the turn end', async () => {
    const { session, provider } = sessionWith();
    provider.runs[0].emit({ kind: 'question', id: 'r1', blocking: true, questions: [QUESTION_SPEC] });
    await settle();
    assert.strictEqual(session.state.status, 'awaiting-approval');

    session.answerQuestion('r1', { q1: ['A'] });
    await settle();

    // The fake provider ends the turn on an answer, exactly as it does on a
    // tool decision — without that the status dot would stick at 'running'
    // forever in the walking skeleton.
    assert.strictEqual(session.state.status, 'idle');
    await session.dispose();
  });

  test('a question parked at dispose is dropped, never answered with an empty set', async () => {
    const { session, provider } = sessionWith();
    provider.runs[0].emit({ kind: 'question', id: 'r1', blocking: true, questions: [QUESTION_SPEC] });
    await settle();

    await session.dispose();

    // `{}` is a real answer to a provider, not a cancellation: on Claude it
    // becomes `{behavior:'allow', updatedInput:{...input, answers:{}}}`.
    // Cancelling is the run's own job, in its own vocabulary.
    assert.deepStrictEqual(provider.answered, []);
  });
});

suite('AgentSession permission metadata', () => {
  let dir: string;
  let store: TranscriptStore;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-session-meta-'));
    store = new TranscriptStore(dir);
  });

  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const TOOL = { kind: 'command' as const, label: 'Bash', command: 'ls' };
  const META = { title: 'Run ls', decisionReason: 'not in the allowlist' };

  test("the event's meta reaches both the parked request and the transcript item", async () => {
    const provider = new FakeProvider();
    const session = new AgentSession(baseState(), provider, store, new RecordingSink());
    provider.runs[0].emit({ kind: 'permission', id: 'p1', tool: TOOL, meta: META });
    await settle();

    const state = await session.snapshot();
    assert.deepStrictEqual(state.pending[0].meta, META);
    const item = state.items.find((i) => i.role === 'permission');
    assert.deepStrictEqual((item as { meta?: unknown }).meta, META);
    await session.dispose();
  });

  test('an event with no meta writes no key at all', async () => {
    const provider = new FakeProvider();
    const session = new AgentSession(baseState(), provider, store, new RecordingSink());
    provider.runs[0].emit({ kind: 'permission', id: 'p1', tool: TOOL });
    await settle();

    const state = await session.snapshot();
    assert.deepStrictEqual(state.pending, [{ requestId: 'p1', tool: TOOL }]);
    assert.strictEqual('meta' in (state.items.find((i) => i.role === 'permission') ?? {}), false);
    await session.dispose();
  });

  test('the meta survives the settled item, so a reloaded card still reads the same', async () => {
    const provider = new FakeProvider();
    const session = new AgentSession(baseState(), provider, store, new RecordingSink());
    provider.runs[0].emit({ kind: 'permission', id: 'p1', tool: TOOL, meta: META });
    await settle();
    session.respondToPermission('p1', { allow: true });
    await settle();
    await session.snapshot(); // forces a flush

    const jsonl = await fs.readFile(path.join(dir, 'sessions', 's1.jsonl'), 'utf8');
    assert.strictEqual(jsonl.includes('"title":"Run ls"'), true);
    assert.strictEqual(jsonl.includes('"decisionReason":"not in the allowlist"'), true);
    await session.dispose();
  });
});

suite('AgentSession activityLabel', () => {
  let dir: string;
  let store: TranscriptStore;
  let sink: RecordingSink;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-activity-'));
    store = new TranscriptStore(dir);
    sink = new RecordingSink();
  });

  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('starts Idle before any event', async () => {
    const session = new AgentSession(baseState(), new FakeProvider(() => []), store, sink);
    assert.strictEqual(session.state.activityLabel, 'Idle');
    await session.dispose();
  });

  test('constructor starts the provider with this session\'s own id', async () => {
    const state = baseState();
    const provider = new FakeProvider();
    const session = new AgentSession(state, provider, store, sink);
    assert.strictEqual(provider.lastStart?.sessionId, state.id);
    await session.dispose();
  });

  test('reports the running tool by its label while one is in flight', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 't1', tool: { kind: 'command', label: 'Bash', command: 'ls' } },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('list files');
    await settle();

    assert.strictEqual(session.state.activityLabel, 'Running Bash');
    await session.dispose();
  });

  test('reports which tool is awaiting approval', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'permission', id: 'r1', tool: { kind: 'command', label: 'Bash', command: 'ls' } },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('list files');
    await settle();

    assert.strictEqual(session.state.activityLabel, 'Waiting for approval: Bash');
    await session.dispose();
  });

  test('returns to Idle once the turn ends', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'tool-start', id: 't1', tool: { kind: 'command', label: 'Bash', command: 'ls' } },
      { kind: 'tool-end', id: 't1', ok: true, output: { kind: 'text', text: 'a.ts' } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('list files');
    await settle();

    assert.strictEqual(session.state.activityLabel, 'Idle');
    await session.dispose();
  });

  test('a subagent-nested tool does not surface as the session-level activity', async () => {
    const provider = new FakeProvider(() => [
      {
        kind: 'tool-start', id: 'task1',
        tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent: 'Explore' },
      },
      {
        kind: 'tool-start', id: 'c1', parentId: 'task1',
        tool: { kind: 'file-read', label: 'Read', path: 'a.ts' },
      },
    ]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('explore');
    await settle();

    assert.strictEqual(session.state.activityLabel, 'Running Task', 'the parent, not its child');
    await session.dispose();
  });

  test('a turn with only assistant text leaves activityLabel running, not stale Idle', async () => {
    // No tool call at all — deliver() alone must move activityLabel off
    // whatever it read before the turn started, the same way it moves
    // status. Deliberately no turn-end in the script: the turn is still
    // in flight when the assertion runs.
    const provider = new FakeProvider(() => [{ kind: 'text', delta: 'Hello there' }]);
    const session = new AgentSession(baseState(), provider, store, sink);
    session.send('hi');
    await settle();

    assert.strictEqual(session.state.status, 'running');
    assert.strictEqual(session.state.activityLabel, 'Running a tool');
    await session.dispose();
  });

  test('a pending question describes waiting on an answer, not on a tool', async () => {
    const provider = new FakeProvider();
    const session = new AgentSession(baseState(), provider, store, sink);
    provider.runs[0].emit({ kind: 'question', id: 'r1', blocking: true, questions: [QUESTION_SPEC] });
    await settle();

    assert.strictEqual(session.state.status, 'awaiting-approval');
    assert.strictEqual(session.state.activityLabel, 'Waiting for your answer');
    await session.dispose();
  });

  test('a pending permission alongside a pending question still names the tool', async () => {
    const provider = new FakeProvider();
    const session = new AgentSession(baseState(), provider, store, sink);
    provider.runs[0].emit({
      kind: 'permission', id: 'p1', tool: { kind: 'command', label: 'Bash', command: 'ls' },
    });
    provider.runs[0].emit({ kind: 'question', id: 'r1', blocking: true, questions: [QUESTION_SPEC] });
    await settle();

    assert.strictEqual(session.state.activityLabel, 'Waiting for approval: Bash');
    await session.dispose();
  });
});
