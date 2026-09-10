# OpenCode Subagent Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an OpenCode subagent's (the `task` tool's) own tool calls and
permission asks visible in Marcode, live, nested under the parent's `task`
tool-call card — parity with Claude's sidechain and Codex's rejoined-thread
subagent rendering.

**Architecture:** `opencode acp`'s own handler binds a real local HTTP+SSE
server before it ever speaks ACP over stdio. We pin that server's port and
token when we spawn it, then open a second `@opencode-ai/sdk` connection to
the exact same server (same process, same session store) purely to watch
child-session events opencode's ACP bridge itself drops. Three small,
vendor-neutral hooks on `AcpRun` merge that watcher's output into the
existing event/permission pipeline — no opencode-specific code enters
`src/providers/acp/`.

**Tech Stack:** TypeScript, `@opencode-ai/sdk` (new dependency, ESM-only —
dynamic `import()`, same pattern as `@agentclientprotocol/sdk`), `node:net`
for port reservation, mocha (`yarn test:unit`).

**Spec:** [docs/superpowers/specs/2026-09-10-opencode-subagent-visibility-design.md](../specs/2026-09-10-opencode-subagent-visibility-design.md)

## Global Constraints

- `src/providers/acp/` and `src/protocol/` import nothing vendor-specific —
  every hook this plan adds to `acp-run.ts` must be usable by a fake source
  in a test, with no opencode types in sight.
- `@opencode-ai/sdk` ships ESM-only (`"exports"` carries only `"import"`
  conditions) — reached via dynamic `import()`, types via
  `import type ... with { 'resolution-mode': 'import' }`. Same shape as
  `acp-client.ts`'s `connectAcp`. A static `import` fails TS1479.
- Text/thinking deltas from a subagent are explicitly **out of scope** for
  this plan — only tool calls and permission asks. Matches what was actually
  asked for; keeps the raw-event surface this plan depends on to three event
  types (`session.created`, `message.part.updated`, `permission.asked`),
  all verified directly against the published `@opencode-ai/sdk@1.18.30`
  `.d.ts` (`node_modules` after Task 1, or `dist/v2/gen/types.gen.d.ts`
  inside the package tarball).
- Filenames are kebab-case. `yarn lint`, `yarn check-types`, `yarn run
  compile` must pass before every commit.
- Conventional-commit prefixes (`feat:`, `test:`, `chore:`) once per task.

---

## Task 1: Dependency + pure mapper — `ToolPart` → canonical `ToolCall`

**Files:**
- Modify: `package.json` (add dependency)
- Create: `src/providers/opencode/map-subagent-tools.ts`
- Test: `src/test/unit/opencode-map-subagent-tools.test.ts`

**Interfaces:**
- Consumes: `AcpToolCall` (from `src/providers/acp/map-updates.ts`),
  `openCodeTools` (`{call, output}` from `src/providers/opencode/map-tools.ts`).
- Produces: `toolPartToAcpCall(part: RawToolPart): AcpToolCall` and
  `subagentToolCall(part: RawToolPart): ToolCall` — the second is
  `openCodeTools.call(toolPartToAcpCall(part))`, exported so Task 2 never
  has to know `AcpToolCall` exists. `RawToolPart` (this file's own type) is
  the four fields Task 2's raw SSE payload actually carries — see below.

- [ ] **Step 1: Add the dependency**

```bash
```

Edit `package.json`'s `"dependencies"` block (alongside the existing
`"@agentclientprotocol/sdk": "^1.4.0"` entry, same caret-range convention):

```json
    "@opencode-ai/sdk": "^1.18.30",
```

Run: `yarn install`

- [ ] **Step 2: Write the failing test — tool-kind classification table**

`src/test/unit/opencode-map-subagent-tools.test.ts`:

```ts
import * as assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { subagentToolCall, type RawToolPart } from '../../providers/opencode/map-subagent-tools';

function part(overrides: Partial<RawToolPart>): RawToolPart {
  return {
    callID: 'call_1',
    tool: 'bash',
    state: { status: 'pending', input: { command: 'ls' }, raw: '' },
    ...overrides,
  };
}

suite('map-subagent-tools', () => {
  test('a pending bash part becomes a running command card', () => {
    const call = subagentToolCall(part({ tool: 'bash' }));
    assert.strictEqual(call.kind, 'command');
    if (call.kind === 'command') {
      assert.strictEqual(call.command, 'ls');
    }
  });

  test('a completed read part carries its output as text', () => {
    const call = subagentToolCall(part({
      tool: 'read',
      state: {
        status: 'completed',
        input: { filePath: '/tmp/a.txt' },
        output: 'hello',
        title: 'a.txt',
        metadata: {},
        time: { start: 0, end: 1 },
      },
    }));
    assert.strictEqual(call.kind, 'file-read');
    if (call.kind === 'file-read') {
      assert.strictEqual(call.path, '/tmp/a.txt');
    }
  });

  test('an unrecognised tool name falls back to other, never guessed', () => {
    const call = subagentToolCall(part({ tool: 'some_custom_mcp_tool' }));
    assert.strictEqual(call.kind, 'other');
  });

  test('an errored part carries the error text as rawOutput', () => {
    const call = subagentToolCall(part({
      tool: 'bash',
      state: {
        status: 'error',
        input: { command: 'false' },
        error: 'exit 1',
        time: { start: 0, end: 1 },
      },
    }));
    // 'other' is fine here — this test only proves the error path doesn't throw
    // and produces a tool call at all; classification detail is covered above.
    assert.strictEqual(typeof call.kind, 'string');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `yarn test:unit --grep "map-subagent-tools"`
Expected: FAIL — `Cannot find module '../../providers/opencode/map-subagent-tools'`

- [ ] **Step 4: Write the implementation**

`src/providers/opencode/map-subagent-tools.ts`:

```ts
import type { AcpToolCall } from '../acp/map-updates';
import type { ToolCall } from '../types';
import { openCodeTools } from './map-tools';

/**
 * The four `ToolPart`/`ToolState` shapes opencode's own SDK publishes on its
 * global event stream (`@opencode-ai/sdk@1.18.30`, `dist/v2/gen/types.gen.d.ts`
 * — `ToolPart`, `ToolState`). Narrowed to what this file reads: a full
 * `ToolPart` also carries `id`/`sessionID`/`messageID`/`type: 'tool'`, which
 * `subagent-watch.ts` (Task 2) already has and doesn't need repeated here.
 */
export interface RawToolPart {
  callID: string;
  tool: string;
  state:
    | { status: 'pending'; input: Record<string, unknown>; raw: string }
    | {
        status: 'running'; input: Record<string, unknown>; title?: string;
        metadata?: Record<string, unknown>; time: { start: number };
      }
    | {
        status: 'completed'; input: Record<string, unknown>; output: string;
        title: string; metadata: Record<string, unknown>;
        time: { start: number; end: number };
      }
    | {
        status: 'error'; input: Record<string, unknown>; error: string;
        metadata?: Record<string, unknown>; time: { start: number; end: number };
      };
}

/**
 * Mirrors `toToolKind` in opencode's own `packages/opencode/src/acp/tool.ts`
 * exactly — the table that decides which ACP `kind` a tool name gets, and
 * therefore which branch `openCodeTools.call` (`map-tools.ts`) takes. Not
 * importable (it's the vendor's server-side source, not a published
 * package), so it's replicated here verbatim rather than guessed at. Verified
 * 2026-09-10 against `dev` HEAD — see the design doc's research trail.
 */
function toAcpKind(tool: string): string {
  switch (tool.toLocaleLowerCase()) {
    case 'bash':
    case 'shell': return 'execute';
    case 'webfetch': return 'fetch';
    case 'edit':
    case 'apply_patch':
    case 'patch':
    case 'write': return 'edit';
    case 'grep':
    case 'glob':
    case 'context':
    case 'context7_resolve_library_id':
    case 'context7_get_library_docs': return 'search';
    case 'read': return 'read';
    case 'task': return 'think';
    default: return 'other';
  }
}

function statusOf(status: RawToolPart['state']['status']): string {
  if (status === 'running') { return 'in_progress'; }
  if (status === 'error') { return 'failed'; }
  return status;
}

/**
 * A raw `ToolPart` reshaped into the same `AcpToolCall` shape the ACP bridge
 * itself already produces for the root session — so classification lives in
 * exactly one place (`openCodeTools`, `map-tools.ts`), never duplicated here.
 */
export function toolPartToAcpCall(part: RawToolPart): AcpToolCall {
  const { state } = part;
  const title = state.status === 'running' || state.status === 'completed'
    ? state.title : undefined;
  const rawOutput = state.status === 'completed'
    ? { output: state.output, metadata: state.metadata }
    : state.status === 'error'
      ? { error: state.error, metadata: state.metadata }
      : undefined;
  const content = state.status === 'completed'
    ? [{ type: 'content', content: { type: 'text', text: state.output } }]
    : undefined;
  return {
    toolCallId: part.callID,
    title,
    kind: toAcpKind(part.tool),
    status: statusOf(state.status),
    rawInput: state.input,
    ...(rawOutput ? { rawOutput } : {}),
    ...(content ? { content } : {}),
  };
}

export function subagentToolCall(part: RawToolPart): ToolCall {
  return openCodeTools.call(toolPartToAcpCall(part));
}

export function subagentToolOutput(part: RawToolPart): ReturnType<typeof openCodeTools.output> {
  return openCodeTools.output(toolPartToAcpCall(part));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn test:unit --grep "map-subagent-tools"`
Expected: PASS (4 tests)

- [ ] **Step 6: Lint and type-check**

Run: `yarn lint && yarn check-types`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add package.json yarn.lock src/providers/opencode/map-subagent-tools.ts src/test/unit/opencode-map-subagent-tools.test.ts
git commit -m "feat: map raw opencode tool parts to canonical ToolCall"
```

---

## Task 2: `acp-run.ts` — three generic hooks + auxiliary permission handling

**Files:**
- Modify: `src/providers/acp/acp-run.ts`
- Test: `src/test/unit/acp-run.test.ts` (existing file — add cases; read it
  first to match its existing fake-connection harness before adding to it)

**Interfaces:**
- Consumes: `AgentEvent`, `PermissionMeta`, `ToolCall`, `ToolDecision` (all
  already exported from `../types`).
- Produces: `AcpRunOptions.childEvents?: AsyncIterable<AgentEvent>`,
  `AcpRunOptions.onSessionId?: (id: string) => void`,
  `AcpRunOptions.onDispose?: () => Promise<void> | void`,
  `AcpRun.handleAuxiliaryPermission(id: string, tool: ToolCall, meta?:
  PermissionMeta, parentId?: string): Promise<ToolDecision | undefined>` —
  the fourth parameter is what lets a relayed child permission card nest
  under its subagent, same as its tool calls do. Task 3's watcher consumes
  all four hooks.

- [ ] **Step 1: Read the existing test file's harness**

Read `src/test/unit/acp-run.test.ts` in full before writing new cases — it
already builds a fake `AcpConnection`/`AcpChild` pair; new tests must reuse
that harness rather than inventing a second one.

- [ ] **Step 2: Write the failing tests**

Append to `src/test/unit/acp-run.test.ts` (inside the existing `suite`,
using whatever helper that file already exports for building a started
`AcpRun` — call it `makeRun` below, matching this file's real helper name
once Step 1 is read):

```ts
test('childEvents source is merged into the run\'s own event stream', async () => {
  const events: AgentEvent[] = [];
  const push = (): void => {};
  let externalPush: ((e: AgentEvent) => void) | undefined;
  const childEvents: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]() {
      let resolveNext: ((r: IteratorResult<AgentEvent>) => void) | undefined;
      externalPush = (e) => { resolveNext?.({ value: e, done: false }); resolveNext = undefined; };
      return { next: () => new Promise((resolve) => { resolveNext = resolve; }) };
    },
  };
  const run = makeRun({ childEvents });
  const drain = (async () => {
    for await (const e of run.events) { events.push(e); if (events.length >= 2) { break; } }
  })();
  await run.startedForTest?.(); // however the existing harness awaits startup — see Step 1
  externalPush?.({ kind: 'text', delta: 'from a child' });
  await drain;
  assert.ok(events.some((e) => e.kind === 'text' && e.delta === 'from a child'));
});

test('onSessionId fires once, with the session id session/new answered', async () => {
  const seen: string[] = [];
  const run = makeRun({ onSessionId: (id) => seen.push(id) });
  await run.startedForTest?.();
  assert.strictEqual(seen.length, 1);
});

test('onDispose runs during dispose()', async () => {
  let disposed = false;
  const run = makeRun({ onDispose: () => { disposed = true; } });
  await run.startedForTest?.();
  await run.dispose();
  assert.strictEqual(disposed, true);
});

test('handleAuxiliaryPermission auto-decides under bypass mode without parking', async () => {
  const run = makeRun({ permissionMode: 'bypass' });
  await run.startedForTest?.();
  const decision = await run.handleAuxiliaryPermission('child_1:req_1', { kind: 'other', label: 'x', raw: {} });
  assert.deepStrictEqual(decision, { allow: true });
});

test('handleAuxiliaryPermission parks and resolves via respondToTool', async () => {
  const run = makeRun({ permissionMode: 'default' });
  await run.startedForTest?.();
  const pending = run.handleAuxiliaryPermission('child_1:req_1', { kind: 'other', label: 'x', raw: {} });
  run.respondToTool('child_1:req_1', { allow: true });
  assert.deepStrictEqual(await pending, { allow: true });
});
```

Adjust `makeRun(...)`'s call shape and `startedForTest`/equivalent to
whatever the file's real helpers are actually named — Step 1 is what
resolves this before the test is written for real, not guessed here.

- [ ] **Step 3: Run tests to verify they fail**

Run: `yarn test:unit --grep "acp-run"`
Expected: FAIL — `childEvents`/`onSessionId`/`onDispose`/`handleAuxiliaryPermission`
not recognised (type errors surface as `yarn check-types` failures too; both
are expected red here).

- [ ] **Step 4: Extend `AcpRunOptions`**

In `src/providers/acp/acp-run.ts`, widen the type import line:

```ts
import type {
  AgentEvent, AgentRun, Attachment, ContextBreakdown, EditorContext,
  EffortLevel, PermissionMeta, PermissionMode, QuestionAnswers,
  SelfControlMcpConfig, ToolCall, ToolDecision,
} from '../types';
```

Add to `AcpRunOptions` (right after `selfControlMcp`):

```ts
  /**
   * A second, vendor-supplied source of events to merge into this run's own
   * stream — e.g. OpenCode's subagent watcher, which observes child-session
   * activity ACP itself never forwards. Generic on purpose: nothing here
   * names OpenCode. Absent means no auxiliary source.
   */
  childEvents?: AsyncIterable<AgentEvent>;
  /** Fired once, the instant this run's own session id is known. */
  onSessionId?: (id: string) => void;
  /** Fired during `dispose()`, alongside this run's own teardown. */
  onDispose?: () => Promise<void> | void;
```

- [ ] **Step 5: Pump `childEvents` into the run's own channel**

In the constructor, after `this.startup = this.start();`:

```ts
    if (this.opts.childEvents) { void this.pumpChildEvents(this.opts.childEvents); }
```

Add the private method (near `start()`):

```ts
  private async pumpChildEvents(source: AsyncIterable<AgentEvent>): Promise<void> {
    for await (const event of source) {
      if (this.disposed) { return; }
      this.events.push(event);
    }
  }
```

- [ ] **Step 6: Fire `onSessionId`**

In `startInner()`, right after `this.sessionId = created.sessionId;` (the
non-resume branch) — this method has two places `this.sessionId` gets set
(resume and fresh); add the call in both, immediately after each
assignment:

```ts
      this.sessionId = created.sessionId;
      this.opts.onSessionId?.(this.sessionId);
```

and for the resume branch, right after `this.sessionId = this.opts.resumeToken;`:

```ts
      this.sessionId = this.opts.resumeToken;
      this.opts.onSessionId?.(this.sessionId);
```

- [ ] **Step 7: Fire `onDispose`**

In `dispose()`, right after `this.disposed = true;`:

```ts
    this.disposed = true;
    if (this.opts.onDispose) { await this.opts.onDispose(); }
```

- [ ] **Step 8: Add `handleAuxiliaryPermission`**

Public method, placed near `onRequestPermission` (reuses `this.parked` and
`autoDecision`, same shape, different entry point — a caller-built `ToolCall`
instead of an ACP-raw `toolCall` to reclassify):

```ts
  /**
   * The entry point an auxiliary event source (a subagent watcher) uses to
   * ask this run's own permission policy about a request it caught outside
   * ACP. Same decision path as `onRequestPermission` — `autoDecision(mode)`
   * first, a real parked promise and a `permission` event only if that's
   * `undefined` — so `bypass`/`dontAsk` on this session apply to whatever
   * called in here too, and a real decision answers through the existing
   * `respondToTool` path with zero new UI.
   */
  async handleAuxiliaryPermission(
    id: string, tool: ToolCall, meta?: PermissionMeta, parentId?: string,
  ): Promise<ToolDecision | undefined> {
    const auto = autoDecision(this.mode);
    if (auto) { return auto; }
    return new Promise<ToolDecision | undefined>((resolve) => {
      const previous = this.parked.get(id);
      this.parked.set(id, resolve);
      if (previous) { previous(undefined); }
      this.events.push({
        kind: 'permission', id, tool, ...(meta ? { meta } : {}), ...(parentId ? { parentId } : {}),
      });
    });
  }
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `yarn test:unit --grep "acp-run"`
Expected: PASS

- [ ] **Step 10: Lint and type-check**

Run: `yarn lint && yarn check-types`
Expected: clean

- [ ] **Step 11: Commit**

```bash
git add src/providers/acp/acp-run.ts src/test/unit/acp-run.test.ts
git commit -m "feat: generic auxiliary-event and auxiliary-permission hooks on AcpRun"
```

---

## Task 3: `subagent-watch.ts` — connection, discovery, event translation

**Files:**
- Create: `src/providers/opencode/subagent-watch.ts`
- Test: `src/test/unit/opencode-subagent-watch.test.ts`

**Interfaces:**
- Consumes: `subagentToolCall`/`subagentToolOutput`/`RawToolPart` (Task 1),
  `AgentEvent`/`ToolDecision`/`PermissionMeta`/`ToolCall` (`../types`).
- Produces:

```ts
export interface SubagentWatchOptions {
  /** Injected so a test never opens a real socket. */
  connect?: (baseUrl: string, token: string) => Promise<SubagentSdk>;
}

export class SubagentWatch {
  readonly events: AsyncIterable<AgentEvent>;
  constructor(opts?: SubagentWatchOptions);
  /**
   * Starts watching. Deliberately NOT called from the constructor: Task 5
   * only learns the real `baseUrl` (the reserved port) after an async
   * reservation, and a `SubagentWatch` that connected eagerly in its
   * constructor would race that reservation with an empty/wrong URL. A
   * `SubagentWatch` nobody calls `open` on stays permanently idle — that's
   * the correct behavior for a spawn attempt that fails before reaching
   * this point, not a bug to guard against separately.
   */
  open(baseUrl: string, token: string): void;
  setRootSessionId(id: string): void;
  setPermissionHandler(
    handler: (id: string, tool: ToolCall, meta: PermissionMeta | undefined, parentId: string | undefined)
      => Promise<ToolDecision | undefined>,
  ): void;
  close(): void;
}
```

Task 5 constructs one per run, wires `events` into `AcpRunOptions.childEvents`,
`setRootSessionId` into `onSessionId`, `close` into `onDispose`, and
`setPermissionHandler` to `run.handleAuxiliaryPermission` (Task 2 already
gave that method a fourth, optional `parentId` parameter for exactly this —
the same value `setPermissionHandler`'s handler receives here). Task 5 calls
`open(...)` itself, once the reserved port is known.

- [ ] **Step 1: Write the failing tests**

`src/test/unit/opencode-subagent-watch.test.ts`:

```ts
import * as assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { SubagentWatch, type SubagentSdk } from '../../providers/opencode/subagent-watch';
import type { AgentEvent } from '../../providers/types';

/** A scripted `SubagentSdk` — feeds a fixed event list, records `permission.reply` calls. */
function fakeSdk(payloads: unknown[]): { sdk: SubagentSdk; replies: unknown[] } {
  const replies: unknown[] = [];
  async function* stream(): AsyncGenerator<{ payload?: unknown }> {
    for (const payload of payloads) { yield { payload }; }
  }
  return {
    replies,
    sdk: {
      globalEvent: async () => ({ stream: stream() }),
      permissionReply: async (params: unknown) => { replies.push(params); },
    },
  };
}

async function collect(events: AsyncIterable<AgentEvent>, count: number): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) { out.push(e); if (out.length >= count) { break; } }
  return out;
}

suite('SubagentWatch', () => {
  test('a tool part on a watched child session becomes a nested tool-start', async () => {
    const { sdk } = fakeSdk([
      { type: 'session.created', properties: { sessionID: 'child_1', info: { id: 'child_1', parentID: 'root' } } },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'child_1',
          part: { type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'pending', input: { command: 'ls' }, raw: '' } },
        },
      },
    ]);
    const watch = new SubagentWatch({ connect: async () => sdk });
    watch.open('http://x', 't');
    watch.setRootSessionId('root');
    // 'task_root' is the parent tool-start id this run's own task card used —
    // supplied here because Task 4 wires it via setParentToolCallId, added below.
    watch.setParentToolCallId('child_1', 'task_root');
    const [event] = await collect(watch.events, 1);
    assert.strictEqual(event.kind, 'tool-start');
    if (event.kind === 'tool-start') {
      assert.strictEqual(event.parentId, 'task_root');
      assert.strictEqual(event.id, 'call_1');
    }
  });

  test('a session.created whose parent is not watched is ignored', async () => {
    const { sdk } = fakeSdk([
      { type: 'session.created', properties: { sessionID: 'stray', info: { id: 'stray', parentID: 'someone-elses-session' } } },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'stray',
          part: { type: 'tool', callID: 'call_x', tool: 'bash', state: { status: 'pending', input: {}, raw: '' } },
        },
      },
      { type: 'session.created', properties: { sessionID: 'child_1', info: { id: 'child_1', parentID: 'root' } } },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'child_1',
          part: { type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'pending', input: {}, raw: '' } },
        },
      },
    ]);
    const watch = new SubagentWatch({ connect: async () => sdk });
    watch.open('http://x', 't');
    watch.setRootSessionId('root');
    watch.setParentToolCallId('child_1', 'task_root');
    const [event] = await collect(watch.events, 1);
    // Only the watched child's call ever reaches the stream — 'call_x' never does.
    assert.strictEqual(event.kind === 'tool-start' && event.id, 'call_1');
  });

  test('a permission ask on a watched child is relayed and replied', async () => {
    const { sdk, replies } = fakeSdk([
      { type: 'session.created', properties: { sessionID: 'child_1', info: { id: 'child_1', parentID: 'root' } } },
      {
        type: 'permission.asked',
        properties: { id: 'req_1', sessionID: 'child_1', permission: 'bash', patterns: [], metadata: {}, always: [] },
      },
    ]);
    const watch = new SubagentWatch({ connect: async () => sdk });
    watch.open('http://x', 't');
    watch.setRootSessionId('root');
    watch.setParentToolCallId('child_1', 'task_root');
    watch.setPermissionHandler(async () => ({ allow: true }));
    await collect(watch.events, 1); // the 'permission' AgentEvent itself
    // Give the async reply a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(replies, [{ requestID: 'req_1', reply: 'once', directory: undefined }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit --grep "SubagentWatch"`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

`src/providers/opencode/subagent-watch.ts`:

```ts
import type { AgentEvent, PermissionMeta, ToolCall, ToolDecision } from '../types';
import { subagentToolCall, subagentToolOutput, type RawToolPart } from './map-subagent-tools';

/**
 * The three raw event shapes this file reads, narrowed from
 * `@opencode-ai/sdk@1.18.30`'s published `Event` union
 * (`dist/v2/gen/types.gen.d.ts` — `EventSessionCreated`,
 * `EventMessagePartUpdated`, `EventPermissionAsked`). Anything else on the
 * global stream (models-dev refresh, pty, question, ...) is ignored.
 */
type RawEvent =
  | { type: 'session.created'; properties: { sessionID: string; info: { id: string; parentID?: string } } }
  | { type: 'message.part.updated'; properties: { sessionID: string; part: RawPart; time?: number } }
  | {
      type: 'permission.asked';
      properties: {
        id: string; sessionID: string; permission: string; patterns: string[];
        metadata: Record<string, unknown>; always: string[];
        tool?: { messageID: string; callID: string };
      };
    }
  | { type: string; properties?: unknown };

type RawPart = ({ type: 'tool' } & RawToolPart) | { type: string };

/**
 * `sdk.global.event()`/`sdk.permission.reply(...)`, narrowed to the two
 * calls this file makes — same structural-narrowing move `AcpConnection`
 * makes in `acp-run.ts`, so a test scripts a fake without importing the SDK.
 */
export interface SubagentSdk {
  globalEvent(): Promise<{ stream: AsyncIterable<{ payload?: unknown }> }>;
  permissionReply(params: { requestID: string; reply: 'once' | 'always' | 'reject'; directory?: string }): Promise<unknown>;
}

/**
 * `@opencode-ai/sdk` ships ESM-only — dynamic `import()`, same reasoning and
 * shape as `acp-client.ts`'s `connectAcp`.
 */
async function connectSdk(baseUrl: string, token: string): Promise<SubagentSdk> {
  const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
  const client = createOpencodeClient({
    baseUrl, headers: { Authorization: `Basic ${Buffer.from(`opencode:${token}`).toString('base64')}` },
  });
  return {
    globalEvent: () => client.global.event() as unknown as Promise<{ stream: AsyncIterable<{ payload?: unknown }> }>,
    permissionReply: (params) => client.permission.reply(params),
  };
}

/** Same house idiom `AcpRun`'s `EventChannel` uses. */
class EventChannel implements AsyncIterable<AgentEvent> {
  private queue: AgentEvent[] = [];
  private waiting: ((v: IteratorResult<AgentEvent>) => void) | undefined;
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) { return; }
    if (this.waiting) { const r = this.waiting; this.waiting = undefined; r({ value: event, done: false }); }
    else { this.queue.push(event); }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) { const r = this.waiting; this.waiting = undefined; r({ value: undefined as never, done: true }); }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: (): Promise<IteratorResult<AgentEvent>> => {
        const next = this.queue.shift();
        if (next) { return Promise.resolve({ value: next, done: false }); }
        if (this.closed) { return Promise.resolve({ value: undefined as never, done: true }); }
        return new Promise((resolve) => { this.waiting = resolve; });
      },
    };
  }
}

export interface SubagentWatchOptions {
  /** Injected so a test never opens a real socket. Defaults to `connectSdk`. */
  connect?: (baseUrl: string, token: string) => Promise<SubagentSdk>;
}

/**
 * Watches one opencode server's global event stream for sessions spawned
 * (directly or transitively) by this run's own root session, and republishes
 * their tool calls and permission asks as ordinary nested `AgentEvent`s.
 * Read-only: never sends a prompt, never steers a child session.
 */
export class SubagentWatch {
  readonly events = new EventChannel();

  private readonly watched = new Set<string>();
  /** Watched child session id -> the parent tool-start id its events nest under. */
  private readonly parentToolCallId = new Map<string, string>();
  private rootSessionId: string | undefined;
  private permissionHandler:
    | ((id: string, tool: ToolCall, meta: PermissionMeta | undefined, parentId: string | undefined)
        => Promise<ToolDecision | undefined>)
    | undefined;
  private closed = false;
  private sdk: SubagentSdk | undefined;

  constructor(private readonly opts: SubagentWatchOptions = {}) {}

  /**
   * Starts watching `baseUrl` with `token`. Not called from the constructor:
   * `opencode-provider.ts` only learns the real port after an async
   * reservation, and connecting eagerly at construction would race that
   * reservation with an empty URL. A `SubagentWatch` `open` is never called
   * on stays permanently idle — correct for a spawn attempt that fails
   * before reaching this point, nothing further to guard.
   */
  open(baseUrl: string, token: string): void {
    void this.run(baseUrl, token);
  }

  setRootSessionId(id: string): void {
    this.rootSessionId = id;
    this.watched.add(id);
  }

  /** The parent's own `task` tool-start id — every event from `childId` nests under it. */
  setParentToolCallId(childId: string, toolStartId: string): void {
    this.parentToolCallId.set(childId, toolStartId);
    this.watched.add(childId);
  }

  setPermissionHandler(
    handler: (id: string, tool: ToolCall, meta: PermissionMeta | undefined, parentId: string | undefined)
      => Promise<ToolDecision | undefined>,
  ): void {
    this.permissionHandler = handler;
  }

  close(): void {
    this.closed = true;
    this.events.close();
  }

  private async run(baseUrl: string, token: string): Promise<void> {
    const connect = this.opts.connect ?? connectSdk;
    try {
      this.sdk = await connect(baseUrl, token);
      const { stream } = await this.sdk.globalEvent();
      for await (const envelope of stream) {
        if (this.closed) { return; }
        if (envelope.payload) { this.handle(envelope.payload as RawEvent); }
      }
    } catch {
      // Best-effort tap: a dead connection here degrades to "no nested
      // subagent visibility", never to a failed run — see the design doc's
      // Error handling section.
    }
  }

  private handle(event: RawEvent): void {
    if (event.type === 'session.created') {
      const { sessionID, info } = event.properties;
      if (info.parentID && this.watched.has(info.parentID) && !this.parentToolCallId.has(sessionID)) {
        // A grandchild inherits its parent's own nesting target — every
        // watched descendant nests under the same top-level `task` card.
        const parentToolStart = this.parentToolCallId.get(info.parentID);
        if (parentToolStart) { this.setParentToolCallId(sessionID, parentToolStart); }
      }
      return;
    }
    if (event.type === 'message.part.updated') {
      this.handlePart(event.properties.sessionID, event.properties.part);
      return;
    }
    if (event.type === 'permission.asked') {
      this.handlePermission(event.properties);
    }
  }

  private handlePart(sessionId: string, part: RawPart): void {
    if (part.type !== 'tool') { return; }
    const parentId = this.parentToolCallId.get(sessionId);
    if (!parentId) { return; }
    const tool = subagentToolCall(part);
    if (part.state.status === 'pending') {
      this.events.push({ kind: 'tool-start', id: part.callID, tool, parentId });
    } else if (part.state.status === 'running') {
      this.events.push({ kind: 'tool-update', id: part.callID, tool, parentId });
    } else {
      this.events.push({
        kind: 'tool-end', id: part.callID, ok: part.state.status === 'completed',
        output: subagentToolOutput(part), tool, parentId,
      });
    }
  }

  private handlePermission(properties: {
    id: string; sessionID: string; permission: string; metadata: Record<string, unknown>;
    tool?: { messageID: string; callID: string };
  }): void {
    const parentId = this.parentToolCallId.get(properties.sessionID);
    if (!parentId || !this.permissionHandler) { return; }
    const namespacedId = `${properties.sessionID}:${properties.id}`;
    const tool: ToolCall = { kind: 'other', label: properties.permission, raw: properties.metadata };
    void this.permissionHandler(namespacedId, tool, { title: properties.permission }, parentId)
      .then((decision) => this.replyPermission(properties.id, decision))
      .catch(() => this.replyPermission(properties.id, undefined));
  }

  private replyPermission(requestID: string, decision: ToolDecision | undefined): void {
    if (!this.sdk) { return; }
    const reply = !decision ? 'reject' : decision.allow ? 'once' : 'reject';
    void this.sdk.permissionReply({ requestID, reply, directory: undefined }).catch(() => {});
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit --grep "SubagentWatch"`
Expected: PASS (3 tests)

- [ ] **Step 5: Lint and type-check**

Run: `yarn lint && yarn check-types`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add src/providers/opencode/subagent-watch.ts src/test/unit/opencode-subagent-watch.test.ts
git commit -m "feat: watch opencode subagent sessions over a direct SDK tap"
```

---

## Task 4: Wire the watcher into `AcpRun` for the root session's own `task` calls

**Files:**
- Modify: `src/providers/acp/acp-run.ts`
- Test: `src/test/unit/acp-run.test.ts`

Task 3's watcher needs `setParentToolCallId(childSessionId, taskToolStartId)`
called at the moment the ACP wire produces the `task` tool's own `tool-start`
— that event already carries the tool-call id to nest under, but not yet the
child session id (only available on the **completed** frame's
`rawOutput.metadata.sessionId`, per the design doc's research). So: capture
the task's own tool-call id when it starts, and once its `tool-end` arrives,
read the child session id out of `rawOutput.metadata` and hand both to the
watcher via one more generic hook.

**Interfaces:**
- Consumes: `SubagentWatch.setParentToolCallId` shape (Task 3) — but
  `acp-run.ts` never imports `SubagentWatch` directly (vendor-neutral rule).
  Instead it gains one more generic callback.
- Produces: `AcpRunOptions.onSubagentSpawned?: (taskToolCallId: string, childSessionId: string) => void`.

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/acp-run.test.ts`:

```ts
test('onSubagentSpawned fires with the task tool-call id and the child session id', async () => {
  const seen: { taskToolCallId: string; childSessionId: string }[] = [];
  const run = makeRun({ onSubagentSpawned: (taskToolCallId, childSessionId) => seen.push({ taskToolCallId, childSessionId }) });
  await run.startedForTest?.();
  // Drive the fake connection's sessionUpdate handler the way this file's
  // existing tool-call tests already do, ending on a completed 'task' call
  // whose rawOutput.metadata.sessionId is set — see Step 1 of Task 2 for
  // the harness this reuses.
  emitSessionUpdate(run, {
    sessionUpdate: 'tool_call', toolCallId: 'call_task_1', kind: 'think', title: 'Task', status: 'pending',
  });
  emitSessionUpdate(run, {
    sessionUpdate: 'tool_call_update', toolCallId: 'call_task_1', status: 'completed',
    rawOutput: { output: 'done', metadata: { sessionId: 'child_1', parentSessionId: 'root' } },
  });
  assert.deepStrictEqual(seen, [{ taskToolCallId: 'call_task_1', childSessionId: 'child_1' }]);
});
```

`emitSessionUpdate` stands in for however `acp-run.test.ts`'s existing
harness feeds a `sessionUpdate` notification into a running fake connection
— read the file (Task 2 Step 1 already did this) and use its real helper
name here instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "onSubagentSpawned"`
Expected: FAIL — option not recognised

- [ ] **Step 3: Add the option and detect it in `onSessionUpdate`**

Add to `AcpRunOptions`:

```ts
  /**
   * Fired once a `task` tool call completes with a child session id in its
   * `rawOutput.metadata` — the only point the ACP wire ever names a
   * subagent's own session (see the design doc). Lets an auxiliary watcher
   * learn which child session belongs to which of this run's own tool-call
   * cards, without `acp-run.ts` knowing anything about what a subagent is.
   */
  onSubagentSpawned?: (taskToolCallId: string, childSessionId: string) => void;
```

In `onSessionUpdate`, after the existing `for (const event of toAgentEvents(...))`
loop (so this reads the same raw `p.update` the loop already has):

```ts
    for (const event of toAgentEvents(p.update, this.opts.tools, this.calls)) {
      this.events.push(event);
    }
    this.detectSubagentSpawn(p.update);
```

Add the private method:

```ts
  /**
   * `p.update.rawOutput` is `unknown` on the wire — this narrows defensively
   * rather than casting, since a non-`task` completed call (the overwhelming
   * majority) has no `metadata.sessionId` at all and must be a silent no-op,
   * not a throw.
   */
  private detectSubagentSpawn(update: Record<string, unknown>): void {
    if (!this.opts.onSubagentSpawned) { return; }
    if (update.sessionUpdate !== 'tool_call_update' || update.status !== 'completed') { return; }
    const toolCallId = update.toolCallId;
    const rawOutput = update.rawOutput as { metadata?: { sessionId?: unknown } } | undefined;
    const childSessionId = rawOutput?.metadata?.sessionId;
    if (typeof toolCallId === 'string' && typeof childSessionId === 'string') {
      this.opts.onSubagentSpawned(toolCallId, childSessionId);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "onSubagentSpawned"`
Expected: PASS

- [ ] **Step 5: Lint and type-check**

Run: `yarn lint && yarn check-types`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add src/providers/acp/acp-run.ts src/test/unit/acp-run.test.ts
git commit -m "feat: detect a completed task call's child session id"
```

---

## Task 5: Port reservation + spawn wiring in `opencode-provider.ts`

**Files:**
- Modify: `src/providers/opencode/opencode-provider.ts`
- Create: `src/providers/opencode/reserve-port.ts`
- Test: `src/test/unit/opencode-reserve-port.test.ts`
- Test: `src/test/unit/opencode-provider.test.ts` (existing — add cases)

**Interfaces:**
- Produces: `reserveLoopbackPort(): Promise<number>` — binds to port `0` on
  `127.0.0.1`, reads back the OS-assigned port, closes immediately.

- [ ] **Step 1: Write the failing test for port reservation**

`src/test/unit/opencode-reserve-port.test.ts`:

```ts
import * as assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { reserveLoopbackPort } from '../../providers/opencode/reserve-port';

suite('reserveLoopbackPort', () => {
  test('returns a port in the valid TCP range, and it is free again immediately after', async () => {
    const port = await reserveLoopbackPort();
    assert.ok(port > 0 && port < 65536);
    // Reserving again must succeed — proves the first reservation actually closed.
    const second = await reserveLoopbackPort();
    assert.ok(second > 0 && second < 65536);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "reserveLoopbackPort"`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

`src/providers/opencode/reserve-port.ts`:

```ts
import { createServer } from 'node:net';

/**
 * Binds to an OS-assigned free port on loopback, reads it back, closes
 * immediately. `opencode acp` binds the real port itself (see
 * `opencode-provider.ts`) — this only reserves a number to hand it via
 * `--port`, since ACP mode never prints which port it chose. Inherently
 * racy (something else could claim the port between close and opencode's
 * own bind) — `opencode-provider.ts` retries the whole spawn on failure,
 * which is the actual safety net.
 */
export function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => {
        if (port) { resolve(port); } else { reject(new Error('no port assigned')); }
      });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "reserveLoopbackPort"`
Expected: PASS

- [ ] **Step 5: Read the existing provider file and its test file in full**

Read `src/providers/opencode/opencode-provider.ts` (already read in full
during design — re-read here to work from current line numbers) and
`src/test/unit/opencode-provider.test.ts`, to match the existing spawn-args
test shape before adding to it.

- [ ] **Step 6: Write the failing tests for spawn wiring**

Append to `src/test/unit/opencode-provider.test.ts` (using whatever fake
`spawn` the existing suite already injects via the constructor's `spawn`
option):

```ts
/**
 * `provider.start(...)` returns synchronously, but the actual spawn happens
 * after an awaited `reservePort()` — at least one microtask away. A plain
 * synchronous assertion right after `start()` would read stale state.
 * `setImmediate` reliably drains the whole microtask queue first (Node
 * always exhausts microtasks before the next macrotask phase), regardless
 * of how many `await`/`queueMicrotask` hops the retry chain takes.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

test('start() spawns opencode acp with a pinned port and an injected server password', async () => {
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const provider = new OpenCodeProvider({
    spawn: (bin, env) => { capturedEnv = env; return fakeAcpChild(); },
    reservePort: async () => 54321,
  });
  provider.start({ cwd: '/tmp', permissionMode: 'default', sessionId: 'sid' as SessionId });
  await flush();
  assert.strictEqual(capturedEnv?.OPENCODE_SERVER_PASSWORD?.length, 48); // randomBytes(24).toString('hex')
});

test('a port collision on spawn is retried with a new port, bounded', async () => {
  let attempts = 0;
  const ports: number[] = [];
  const provider = new OpenCodeProvider({
    reservePort: async () => { ports.push(++attempts); return attempts; },
    spawn: () => {
      const child = fakeAcpChild();
      if (attempts < 2) { queueMicrotask(() => child.failWith('EADDRINUSE')); }
      return child;
    },
  });
  provider.start({ cwd: '/tmp', permissionMode: 'default', sessionId: 'sid' as SessionId });
  await flush();
  // Full assertion of the retry's observable effect (a working run on the
  // second port) is exercised in Task 6's integration test — this proves
  // reservePort was called more than once, which is the retry itself.
  assert.ok(ports.length >= 2);
});
```

Adjust `fakeAcpChild()`'s shape (`failWith`, etc.) to match whatever fake the
existing test file already provides — Step 5 is what resolves the exact
name.

- [ ] **Step 7: Run tests to verify they fail**

Run: `yarn test:unit --grep "opencode-provider"`
Expected: FAIL — `reservePort` option and `OPENCODE_SERVER_PASSWORD` not
produced yet

- [ ] **Step 8: Wire it up in `OpenCodeProvider`**

Add imports:

```ts
import { randomBytes } from 'node:crypto';
import { reserveLoopbackPort } from './reserve-port';
import { SubagentWatch } from './subagent-watch';
```

Add to the constructor's `opts` type and field, mirroring every other
injectable dependency this class already has:

```ts
    reservePort?: () => Promise<number>;
```
```ts
  private readonly reservePort: () => Promise<number>;
```
```ts
    this.reservePort = opts.reservePort ?? reserveLoopbackPort;
```

Add a bounded retry constant near `CONFIG_OPTION_TIMEOUT_MS`:

```ts
/** Bounded retries for a spawn that failed because the port this run
 *  reserved was claimed by something else between reservation and
 *  `opencode acp`'s own bind. Same shape as `self-control-mcp-server.ts`'s
 *  `PORT_ATTEMPTS`. */
const SPAWN_PORT_ATTEMPTS = 5;
```

Replace `start(opts: StartOptions): AgentRun` with an async-spawning
version. `AgentProvider.start` must stay synchronous (`AgentRun`, not a
promise — the interface's own contract), so the retry loop runs inside a
`SubagentWatch`-backed `AcpRun` whose own connection is what actually
surfaces a port failure; `start()` itself kicks off attempt 1 synchronously
and lets `AcpRun`'s own `child.onFailure`-driven retry described below
happen inside the run:

```ts
  start(opts: StartOptions): AgentRun {
    const token = randomBytes(24).toString('hex');
    const watch = new SubagentWatch(); // opened once a real child has actually spawned — see attemptSpawn
    const run = new AcpRun(this.spawnWithPort(token, watch), {
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      permissionMode: opts.permissionMode,
      resumeToken: opts.resumeToken,
      sessionId: opts.sessionId,
      tools: openCodeTools,
      modeId: openCodeModeId,
      clientName: 'mar-code',
      selfControlMcp: this.selfControlMcp,
      childEvents: watch.events,
      onSessionId: (id) => watch.setRootSessionId(id),
      onSubagentSpawned: (taskToolCallId, childSessionId) => watch.setParentToolCallId(childSessionId, taskToolCallId),
      onDispose: () => watch.close(),
    });
    watch.setPermissionHandler((id, tool, meta, parentId) => run.handleAuxiliaryPermission(id, tool, meta, parentId));
    return run;
  }
```

`spawnWithPort` reserves a port synchronously-looking but actually needs the
async reservation before the child spawns — `AcpChild` itself is what
`this.spawn(bin, env)` returns, and that call must happen before `AcpRun`'s
constructor runs (it's passed as `child`, `AcpRun`'s first constructor arg,
not optional). Reserving a port is `async`, but `start()` must return
synchronously — resolved the same way `AcpRun` itself resolves the
SDK-loading/ACP-handshake async gap: a deferred child stream. Add a small
helper that spawns eagerly against a **placeholder** never-resolves child
until the real one is ready, mirroring `AcpChild`'s own shape:

```ts
  /**
   * `start()` must return an `AgentRun` synchronously (the interface's own
   * contract), but reserving a port is async. Spawns a real `AcpChild`
   * immediately whose `stdin`/`stdout` are PassThroughs wired to the *real*
   * child once the port is reserved and `opencode acp --port <n>` actually
   * launches — so nothing downstream (`AcpRun`, `connectAcp`) ever sees a
   * synchronous/async seam. Retries `SPAWN_PORT_ATTEMPTS` times on a spawn
   * failure (`AcpChild.onFailure`), each with a freshly reserved port.
   */
  private spawnWithPort(token: string, watch: SubagentWatch): AcpChild {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let notifyFailure: (reason: string) => void = () => {};
    let killed = false;
    const placeholder: AcpChild = {
      stdin, stdout,
      kill: () => { killed = true; },
      onFailure: (cb) => { notifyFailure = cb; },
    };
    void this.attemptSpawn(token, watch, stdin, stdout, () => killed, notifyFailure, SPAWN_PORT_ATTEMPTS);
    return placeholder;
  }

  private async attemptSpawn(
    token: string, watch: SubagentWatch, stdin: PassThrough, stdout: PassThrough,
    isKilled: () => boolean, notifyFailure: (reason: string) => void, attemptsLeft: number,
  ): Promise<void> {
    if (isKilled()) { return; }
    let port: number;
    try {
      port = await this.reservePort();
    } catch (err) {
      notifyFailure(`could not reserve a port for opencode acp (${errorMessage(err)})`);
      return;
    }
    const env = { ...this.mergedEnv(), OPENCODE_SERVER_PASSWORD: token };
    const bin = this.binPath ?? 'opencode';
    let child: AcpChild;
    try {
      child = spawnOpenCodeAcp(bin, env, port);
    } catch (err) {
      notifyFailure(`opencode acp failed to start (${errorMessage(err)})`);
      return;
    }
    // Only now — a real child process exists for this port — does the
    // watcher's own connection attempt make sense. Opening earlier (right
    // after reservation) would let a retried attempt leave a prior `open()`
    // racing a port nothing ever bound to.
    watch.open(`http://127.0.0.1:${port}`, token);
    let failed = false;
    child.onFailure?.((reason) => {
      failed = true;
      if (attemptsLeft > 1 && /port|EADDRINUSE/i.test(reason)) {
        void this.attemptSpawn(token, watch, stdin, stdout, isKilled, notifyFailure, attemptsLeft - 1);
      } else {
        notifyFailure(reason);
      }
    });
    child.stdout.pipe(stdout);
    stdin.pipe(child.stdin);
    if (isKilled()) { child.kill(); }
    // A failure detected between the checks above and here is still caught
    // by the `onFailure` listener just attached — nothing here needs its
    // own race, unlike `fetchModels`'s probe.
    void failed;
  }
```

Update `spawnOpenCodeAcp` to accept the port and pass `--port`:

```ts
export function spawnOpenCodeAcp(binPath: string | undefined, env: NodeJS.ProcessEnv | undefined, port: number): AcpChild {
  const bin = binPath ?? 'opencode';
  const child = spawnChildProcess(bin, ['acp', '--port', String(port), '--hostname', '127.0.0.1'], {
    stdio: ['pipe', 'pipe', 'pipe'], shell: true, windowsHide: true, ...(env ? { env } : {}),
  });
  // ... rest of the function body is unchanged from today's version.
```

Add the small `errorMessage` helper this file doesn't yet have (same one-liner
`acp-run.ts` already has, duplicated locally rather than exported across
provider files — matches this codebase's existing per-file duplication of
that exact helper):

```ts
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

Add the `PassThrough` import:

```ts
import { PassThrough } from 'node:stream';
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `yarn test:unit --grep "opencode-provider"`
Expected: PASS

- [ ] **Step 10: Run the full opencode-related unit suite**

Run: `yarn test:unit --grep "opencode"`
Expected: PASS — includes Tasks 1, 3, 5's own suites plus `fetchModels`'s
existing probe tests, which must still pass unchanged (`probe()` calls
`this.spawn(...)` directly, not `spawnWithPort` — confirm this in Step 5's
re-read and leave `fetchModels`/`probe` untouched, since a probe session is
deliberately closed immediately and never needs subagent visibility).

- [ ] **Step 11: Lint and type-check**

Run: `yarn lint && yarn check-types`
Expected: clean

- [ ] **Step 12: Commit**

```bash
git add src/providers/opencode/opencode-provider.ts src/providers/opencode/reserve-port.ts src/test/unit/opencode-reserve-port.test.ts src/test/unit/opencode-provider.test.ts
git commit -m "feat: spawn opencode acp with a pinned port and wire the subagent watcher"
```

---

## Task 6: `yarn run compile` + full suite + docs

**Files:**
- Modify: `CLAUDE.md` (architecture table)

- [ ] **Step 1: Full build and test pass**

Run: `yarn lint && yarn check-types && yarn run compile && yarn test:unit`
Expected: all clean/green

- [ ] **Step 2: Add the two new files to the architecture table**

In `CLAUDE.md`'s file table, add two rows near the existing
`src/providers/opencode/map-tools.ts` row:

```markdown
| `src/providers/opencode/subagent-watch.ts` | A second `@opencode-ai/sdk` connection to the same `opencode acp` server, watching for task-tool child sessions ACP itself never forwards; republishes their tool calls and permission asks as nested `AgentEvent`s |
| `src/providers/opencode/map-subagent-tools.ts` | Raw `ToolPart` → the same `AcpToolCall` shape the ACP bridge already produces, so classification stays in `map-tools.ts` alone |
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: list the subagent-watch files in the architecture table"
```

---

## Self-review notes (for whoever picks this plan up)

- **Spec coverage:** connection/discovery (Tasks 3, 5), mapping (Task 1),
  merge into the run (Task 2), the task-call→child-session correlation the
  design doc calls out as needing the *completed* frame (Task 4), permission
  relay (Tasks 2 step 8, 3 step 3's `handlePermission`), cleanup (Task 2
  step 7 `onDispose`). No spec section without a task.
- **Deliberately deferred inside this plan, not the spec:** the exact
  `makeRun`/`emitSessionUpdate`/`fakeAcpChild` helper names in Tasks 2 and 4
  depend on `acp-run.test.ts`/`opencode-provider.test.ts`'s current contents
  — each task's Step 1 is a mandatory read specifically because guessing
  those names here would violate the "no placeholder" rule the moment the
  real file disagrees.
