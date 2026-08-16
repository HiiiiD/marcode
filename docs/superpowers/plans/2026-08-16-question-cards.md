# Question Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the panel answer structured questions from either backend, instead of rendering them as an allow/deny permission card (Claude) or auto-declining them (codex).

**Architecture:** A new provider-agnostic `question` event travels beside the existing `permission` event, is parked by `AgentSession` the way approvals are, renders as a stepper card in the webview, and returns as `updatedInput.answers` (Claude) or a `ToolRequestUserInputResponse` (codex). `ToolDecision` is not widened. A second, smaller strand surfaces permission metadata the SDK already sends and the panel currently discards, and fixes `interrupt()` leaving parked requests unsettled.

**Tech Stack:** TypeScript, React 19, Tailwind v4, Base UI-backed shadcn primitives, esbuild (node/CJS host bundle + browser/IIFE webview bundle), mocha (`yarn test:unit`), mocha + jsdom (`yarn test:dom`), `@vscode/test-cli` (`yarn test`).

**Spec:** `docs/superpowers/specs/2026-08-16-question-cards-design.md`

## Global Constraints

- `src/protocol/messages.ts` is **types-only**. No runtime code, no `vscode` import, no `@anthropic-ai/*` import.
- Nothing under `src/providers/` or `src/protocol/` imports `vscode`. Neither does `src/host/message-router.ts`.
- Every protocol message addressed to a session carries an explicit `SessionId`.
- Errors are state, never exceptions. Nothing rejects across `postMessage`.
- Transcript patches fan out only to visible sessions. `sessions-changed` / `session-status` are ungated.
- Filenames are kebab-case; component identifiers stay PascalCase.
- **Never pass a DOM node to an assertion.** Compare a boolean, a string, or a count. `assert.strictEqual(el === null, true)`, never `assert.strictEqual(el, null)`.
- DOM tests drive components through the real `StoreProvider` via `sendFromHost`; assertions read `posted()`. Never mock `useStore`, never hand-build a `ClientState`.
- No raw HTML controls in feature code. Use `@/components/ui/*`. Compose classNames with `cn` from `@/lib/utils` — never template literals.
- Usage and context surfaces read in percentages (not touched here, but do not regress).
- `yarn lint`, `yarn check-types` and `yarn run compile` must all pass before every commit.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `docs:`.
- Every change under `src/webview/components/` runs the impeccable detector (Task 12).

---

### Task 1: Probe whether bypass mode suppresses `canUseTool`

The spec's Open Item 1. This runs first because its outcome decides whether question cards work in bypass mode at all, and it may delete a line rather than add one.

**Files:**
- Modify (conditional on outcome): `src/providers/claude/claude-provider.ts:450`
- Modify: `docs/superpowers/specs/2026-08-16-question-cards-design.md` (record the answer)

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded answer in the spec. No code symbols.

- [ ] **Step 1: Write a throwaway probe script**

`buildOptions()` currently sets both `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true`. Determine whether the flag suppresses the `canUseTool` callback.

```ts
// scratch/probe-bypass.ts — throwaway, not committed
import { query } from '@anthropic-ai/claude-agent-sdk';

async function run(useFlag: boolean) {
  let called = false;
  const prompts = (async function* () {
    yield { type: 'user' as const, message: { role: 'user' as const, content: 'Read package.json' }, parent_tool_use_id: null, session_id: '' };
  })();
  const q = query({
    prompt: prompts as never,
    options: {
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
      ...(useFlag ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: async () => { called = true; return { behavior: 'allow' as const }; },
    },
  });
  for await (const _ of q) { /* drain */ }
  console.log(`flag=${useFlag} canUseTool called=${called}`);
}

void (async () => { await run(true); await run(false); })();
```

- [ ] **Step 2: Run the probe**

Run: `npx tsx scratch/probe-bypass.ts`
Expected: two lines reporting whether `canUseTool` fired with and without the flag.

- [ ] **Step 3: Record the outcome in the spec**

Replace Open Item 1 in `docs/superpowers/specs/2026-08-16-question-cards-design.md` with the measured result. Write what was observed, not what was expected.

- [ ] **Step 4: If the flag suppresses the callback, drop it**

Only if the probe shows `canUseTool` fires without the flag but not with it, remove line 450's spread from `buildOptions()`:

```ts
        ...(isBypassMode ? { allowDangerouslySkipPermissions: true } : {}),
```

Then update the existing test at `src/test/unit/claude-provider.test.ts:137` (`"setPermissionMode('bypass') before the first send() sets both the mode and the flag at construction"`) to assert the mode alone, and rename it to `"setPermissionMode('bypass') before the first send() sets the mode"`.

- [ ] **Step 5: Run the suite**

Run: `yarn test:unit && yarn lint && yarn check-types`
Expected: PASS.

- [ ] **Step 6: Delete the probe and commit**

```bash
rm scratch/probe-bypass.ts
git add docs/superpowers/specs/2026-08-16-question-cards-design.md
# plus claude-provider.ts and the test if Step 4 applied
git commit -m "docs: record bypass-mode probe result for question cards"
```

---

### Task 2: Neutral and protocol types

Types only, no behaviour. Its gate is the compiler.

**Files:**
- Modify: `src/providers/types.ts`
- Modify: `src/protocol/messages.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `QuestionOption`, `QuestionSpec`, `QuestionAnswers`, `PermissionMeta` (from `src/providers/types.ts`); `QuestionRequest`, the `question` transcript role, `SessionState.pendingQuestions`, and the `question-answer` message (from `src/protocol/messages.ts`). Every later task depends on these exact names.

- [ ] **Step 1: Add the neutral types**

In `src/providers/types.ts`, beside the existing `ToolDecision` (line 98):

```ts
export interface QuestionOption {
  label: string;
  description: string;
  /** Claude only. Longer comparison content, rendered as markdown. */
  preview?: string;
}

export interface QuestionSpec {
  /**
   * Stable answer key. Codex supplies one per question; Claude has no id, so
   * its adapter uses the question text and maps back at its own boundary.
   */
  id: string;
  header: string;
  question: string;
  /** Absent means a free-text question with no options to choose from. */
  options?: QuestionOption[];
  multiSelect: boolean;
  /** Whether a free-text answer is offered alongside the options. */
  allowOther: boolean;
  /** The answer is a credential: masked on input, never persisted. */
  secret: boolean;
}

/** Question id -> that question's answers. A list because codex is list-native. */
export type QuestionAnswers = Record<string, string[]>;

/**
 * What the backend's own permission engine already worked out about a
 * request. Every field is optional: a provider reports what it has.
 */
export interface PermissionMeta {
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
}
```

- [ ] **Step 2: Extend `AgentEvent` and `AgentRun`**

In the `AgentEvent` union (line 176), replace the `permission` member and add two:

```ts
  | { kind: 'permission'; id: string; tool: ToolCall; parentId?: string; meta?: PermissionMeta }
  | { kind: 'question'; id: string; questions: QuestionSpec[]; blocking: boolean; parentId?: string }
  | { kind: 'request-cancelled'; id: string }
```

In `AgentRun`, beside `respondToTool` (line 196):

```ts
  /**
   * Answers a parked `question`. Fire-and-forget like the other responders:
   * callers must never see this reject.
   */
  respondToQuestion(id: string, answers: QuestionAnswers): void;
```

- [ ] **Step 3: Extend the protocol**

In `src/protocol/messages.ts`, re-export the new types alongside the existing ones (lines 3 and 8), add the transcript role after the `permission` member (line 50):

```ts
  /**
   * A structured question from the agent. Blocking ones freeze the composer;
   * codex can send non-blocking ones. `answers` omits the key of any question
   * whose spec is `secret` — combined with `state: 'answered'` that reads as
   * "asked, answered, deliberately not recorded".
   */
  | (ItemBase & {
      role: 'question'; requestId: string; questions: QuestionSpec[]; blocking: boolean;
      state: 'pending' | 'answered' | 'cancelled' | 'stale';
      answers?: QuestionAnswers;
    })
```

Add the request type beside `PermissionRequest` (line 80), extend it, and extend `SessionState`:

```ts
export interface PermissionRequest { requestId: string; tool: ToolCall; meta?: PermissionMeta }
export interface QuestionRequest { requestId: string; questions: QuestionSpec[]; blocking: boolean }
```

In `SessionState`, beside `pending` (line 129):

```ts
  pendingQuestions: QuestionRequest[];
```

And one inbound message beside `permission-decision` (line 256):

```ts
  | { t: 'question-answer'; id: SessionId; requestId: string; answers: QuestionAnswers }
```

- [ ] **Step 4: Compile**

Run: `yarn check-types`
Expected: FAIL — every `AgentRun` implementation is now missing `respondToQuestion`, and every `SessionState` construction is missing `pendingQuestions`. That failure list is the work of Tasks 3, 6 and 7.

- [ ] **Step 5: Add the minimal stubs that make it compile**

Add to `FakeProvider`'s run (`src/providers/fake/fake-provider.ts`), `ClaudeProvider`'s run, and `CodexRun`:

```ts
      respondToQuestion: () => { /* replaced in Tasks 3 and 6 */ },
```

And `pendingQuestions: []` wherever a `SessionState` is built (`src/host/agent-session.ts:454` and any fixture).

- [ ] **Step 6: Compile, lint, commit**

Run: `yarn check-types && yarn lint && yarn test:unit`
Expected: PASS.

```bash
git add src/providers/types.ts src/protocol/messages.ts src/providers/fake/fake-provider.ts src/providers/claude/claude-provider.ts src/providers/codex/codex-run.ts src/host/agent-session.ts
git commit -m "feat: wire types for question cards"
```

---

### Task 3: Claude — park `AskUserQuestion` and answer it

**Files:**
- Modify: `src/providers/claude/claude-provider.ts:376-412` (the `approvals` map and `canUseTool`)
- Test: `src/test/unit/claude-provider.test.ts`

**Interfaces:**
- Consumes: `QuestionSpec`, `QuestionAnswers`, `AgentEvent`'s `question` kind (Task 2).
- Produces: `ClaudeProvider` emitting `{kind:'question'}` and honouring `run.respondToQuestion(id, answers)`. Answer values reach the SDK as `Record<questionText, string>`, comma-joined with `', '`.

- [ ] **Step 1: Write the failing tests**

Add to `src/test/unit/claude-provider.test.ts`. The fake query factory already exists in that file; extend it to expose the `canUseTool` it was constructed with, by recording `params.options.canUseTool` in `calls`.

```ts
suite('ClaudeProvider (questions)', () => {
  test('AskUserQuestion emits a question event rather than a permission', async () => {
    const { queryFn, calls } = fakeLoadQuery();
    const provider = new ClaudeProvider(async () => queryFn);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    const events = collect(run);
    run.send('hi');
    await tick();

    const canUseTool = calls[0].options.canUseTool as CanUseToolLike;
    void canUseTool('AskUserQuestion', {
      questions: [{
        header: 'Scope', question: 'Which one?', multiSelect: false,
        options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }],
      }],
    }, { toolUseID: 't1', signal: new AbortController().signal, requestId: 'rq1' });
    await tick();

    const q = events().find((e) => e.kind === 'question');
    assert.strictEqual(q?.kind, 'question');
    assert.strictEqual(q.blocking, true);
    assert.strictEqual(q.questions.length, 1);
    assert.strictEqual(q.questions[0].id, 'Which one?');
    assert.strictEqual(q.questions[0].allowOther, true);
    assert.strictEqual(q.questions[0].secret, false);
    assert.strictEqual(q.questions[0].options?.length, 2);
    assert.strictEqual(events().some((e) => e.kind === 'permission'), false);
  });

  test('respondToQuestion resolves with answers spread over the original input', async () => {
    const { queryFn, calls } = fakeLoadQuery();
    const provider = new ClaudeProvider(async () => queryFn);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    collect(run);
    run.send('hi');
    await tick();

    const canUseTool = calls[0].options.canUseTool as CanUseToolLike;
    const input = {
      questions: [{
        header: 'Scope', question: 'Which one?', multiSelect: true,
        options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }],
      }],
    };
    const decision = canUseTool('AskUserQuestion', input,
      { toolUseID: 't1', signal: new AbortController().signal, requestId: 'rq1' });
    run.respondToQuestion('t1', { 'Which one?': ['A', 'B'] });

    assert.deepStrictEqual(await decision, {
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'Which one?': 'A, B' } },
    });
  });

  test('a malformed questions payload degrades to a permission card', async () => {
    const { queryFn, calls } = fakeLoadQuery();
    const provider = new ClaudeProvider(async () => queryFn);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    const events = collect(run);
    run.send('hi');
    await tick();

    const canUseTool = calls[0].options.canUseTool as CanUseToolLike;
    void canUseTool('AskUserQuestion', { questions: 'not an array' },
      { toolUseID: 't1', signal: new AbortController().signal, requestId: 'rq1' });
    await tick();

    assert.strictEqual(events().some((e) => e.kind === 'permission'), true);
    assert.strictEqual(events().some((e) => e.kind === 'question'), false);
  });
});
```

Add near the top of the file:

```ts
type CanUseToolLike = (
  toolName: string,
  input: Record<string, unknown>,
  options: { toolUseID: string; signal: AbortSignal; requestId: string },
) => Promise<unknown>;
```

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test:unit --grep "ClaudeProvider \(questions\)"`
Expected: FAIL — `question` events are never emitted; `respondToQuestion` is the Task 2 stub.

- [ ] **Step 3: Add the mapper**

Create `src/providers/claude/map-questions.ts`:

```ts
import type { QuestionAnswers, QuestionSpec } from '../types';

/**
 * `AskUserQuestion`'s input -> neutral specs, or undefined when the payload
 * is not the documented shape. The input is model-supplied, so "not the
 * documented shape" is a real case and the caller degrades rather than throws.
 *
 * Claude has no question id. The question text is the id, because that is
 * exactly what `AskUserQuestionOutput.answers` is keyed by.
 */
export function toQuestionSpecs(input: Record<string, unknown>): QuestionSpec[] | undefined {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) { return undefined; }
  const specs: QuestionSpec[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) { return undefined; }
    const q = entry as Record<string, unknown>;
    if (typeof q.question !== 'string' || typeof q.header !== 'string') { return undefined; }
    if (!Array.isArray(q.options) || q.options.length === 0) { return undefined; }
    const options = [];
    for (const o of q.options) {
      if (typeof o !== 'object' || o === null) { return undefined; }
      const opt = o as Record<string, unknown>;
      if (typeof opt.label !== 'string' || typeof opt.description !== 'string') { return undefined; }
      options.push({
        label: opt.label,
        description: opt.description,
        ...(typeof opt.preview === 'string' ? { preview: opt.preview } : {}),
      });
    }
    specs.push({
      id: q.question,
      header: q.header,
      question: q.question,
      options,
      multiSelect: q.multiSelect === true,
      // The tool's schema promises the model that an "Other" escape is
      // provided by the harness, so it is never per-question on this side.
      allowOther: true,
      // Claude has no secret questions. Codex does.
      secret: false,
    });
  }
  return specs;
}

/**
 * Neutral answers -> the string map `AskUserQuestionOutput.answers` documents:
 * question text to answer, multi-select comma-joined.
 */
export function toSdkAnswers(answers: QuestionAnswers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, values] of Object.entries(answers)) { out[id] = values.join(', '); }
  return out;
}
```

- [ ] **Step 4: Branch in `canUseTool` and add `respondToQuestion`**

Replace the `approvals` map (line 376) and `canUseTool` (line 403):

```ts
    type Parked =
      | { kind: 'permission'; resolve: (decision: ToolDecision) => void }
      | { kind: 'question'; input: Record<string, unknown>; resolve: (answers: QuestionAnswers) => void };
    const parked = new Map<string, Parked>();

    const canUseTool: CanUseTool = async (toolName, input, options) => {
      const id = options.toolUseID;
      const specs = toolName === 'AskUserQuestion' ? toQuestionSpecs(input) : undefined;
      if (specs) {
        events.push({ kind: 'question', id, questions: specs, blocking: true });
        const answers = await new Promise<QuestionAnswers>((resolve) => {
          parked.set(id, { kind: 'question', input, resolve });
        });
        return { behavior: 'allow', updatedInput: { ...input, answers: toSdkAnswers(answers) } };
      }
      events.push({ kind: 'permission', id, tool: toToolCall(toolName, input) });
      const decision = await new Promise<ToolDecision>((resolve) => {
        parked.set(id, { kind: 'permission', resolve });
      });
      return decision.allow
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: decision.reason ?? 'Denied by user' };
    };
```

Update `respondToTool` (line 532) to read the new map, and implement `respondToQuestion`:

```ts
      respondToTool: (id, decision) => {
        const entry = parked.get(id);
        if (entry?.kind === 'permission') { parked.delete(id); entry.resolve(decision); }
      },
      respondToQuestion: (id, answers) => {
        const entry = parked.get(id);
        if (entry?.kind === 'question') { parked.delete(id); entry.resolve(answers); }
      },
```

Update `dispose()` (line 650) to settle both kinds:

```ts
        for (const [, entry] of parked) {
          if (entry.kind === 'permission') { entry.resolve({ allow: false, reason: 'Session closed' }); }
          else { entry.resolve({}); }
        }
        parked.clear();
```

- [ ] **Step 5: Run the tests**

Run: `yarn test:unit --grep "ClaudeProvider"`
Expected: PASS, including the pre-existing tests in that suite.

- [ ] **Step 6: Commit**

```bash
git add src/providers/claude/map-questions.ts src/providers/claude/claude-provider.ts src/test/unit/claude-provider.test.ts
git commit -m "feat: park and answer AskUserQuestion in the Claude provider"
```

---

### Task 4: Claude — settle parked requests on abort and interrupt

Includes the regression test for the pre-existing bug where `interrupt()` strands a parked permission.

**Files:**
- Modify: `src/providers/claude/claude-provider.ts` (`canUseTool`, `interrupt`)
- Test: `src/test/unit/claude-provider.test.ts`

**Interfaces:**
- Consumes: the `Parked` map and `canUseTool` from Task 3; `request-cancelled` from Task 2.
- Produces: `ClaudeProvider` emitting `{kind:'request-cancelled', id}` when a parked entry is settled by cancellation rather than by the user.

- [ ] **Step 1: Write the failing tests**

```ts
suite('ClaudeProvider (cancellation)', () => {
  test('interrupt settles a parked permission — it does not strand the card', async () => {
    const { queryFn, calls } = fakeLoadQuery();
    const provider = new ClaudeProvider(async () => queryFn);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    const events = collect(run);
    run.send('hi');
    await tick();

    const canUseTool = calls[0].options.canUseTool as CanUseToolLike;
    const decision = canUseTool('Write', { file_path: '/tmp/a' },
      { toolUseID: 't1', signal: new AbortController().signal, requestId: 'rq1' });
    await run.interrupt();

    assert.deepStrictEqual(await decision, { behavior: 'deny', message: 'Turn cancelled' });
    assert.strictEqual(events().some((e) => e.kind === 'request-cancelled' && e.id === 't1'), true);
  });

  test('an aborted question resolves deny, never null', async () => {
    const { queryFn, calls } = fakeLoadQuery();
    const provider = new ClaudeProvider(async () => queryFn);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    collect(run);
    run.send('hi');
    await tick();

    const controller = new AbortController();
    const canUseTool = calls[0].options.canUseTool as CanUseToolLike;
    const decision = canUseTool('AskUserQuestion', {
      questions: [{ header: 'H', question: 'Q?', multiSelect: false,
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }],
    }, { toolUseID: 't1', signal: controller.signal, requestId: 'rq1' });
    controller.abort();

    assert.deepStrictEqual(await decision, { behavior: 'deny', message: 'Turn cancelled' });
  });

  test('an abort followed by interrupt settles once and emits one cancellation', async () => {
    const { queryFn, calls } = fakeLoadQuery();
    const provider = new ClaudeProvider(async () => queryFn);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    const events = collect(run);
    run.send('hi');
    await tick();

    const controller = new AbortController();
    const canUseTool = calls[0].options.canUseTool as CanUseToolLike;
    const decision = canUseTool('Write', { file_path: '/tmp/a' },
      { toolUseID: 't1', signal: controller.signal, requestId: 'rq1' });
    controller.abort();
    await run.interrupt();
    await decision;

    assert.strictEqual(events().filter((e) => e.kind === 'request-cancelled').length, 1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test:unit --grep "ClaudeProvider \(cancellation\)"`
Expected: FAIL — the first test hangs on an unsettled promise until mocha times out, which is precisely the bug.

- [ ] **Step 3: Add one settle path both callers share**

In the run closure, after `parked` is declared:

```ts
    /**
     * Settles a parked entry as cancelled. Deletes before resolving, so an
     * abort and an explicit interrupt cannot double-resolve or double-report.
     *
     * A question resolves `deny` and never `null`: the SDK reserves null for
     * "control_response already sent out-of-band", and an accidental null
     * leaves the tool blocked with no park deadline (sdk.d.ts:196-204).
     */
    const cancelParked = (id: string) => {
      const entry = parked.get(id);
      if (!entry) { return; }
      parked.delete(id);
      events.push({ kind: 'request-cancelled', id });
      if (entry.kind === 'permission') { entry.resolve({ allow: false, reason: 'Turn cancelled' }); }
      else { entry.resolve(CANCELLED); }
    };
```

The question branch resolves with a sentinel so its `canUseTool` can tell a real answer from a cancellation. Declare it at module scope:

```ts
/** Sentinel: a parked question settled by cancellation, not by an answer. */
const CANCELLED: QuestionAnswers = Object.freeze({ __cancelled__: [] }) as QuestionAnswers;
```

In the question branch of `canUseTool`, after the await:

```ts
        if (answers === CANCELLED) { return { behavior: 'deny', message: 'Turn cancelled' }; }
```

And in the permission branch, the existing `decision.allow` check already yields `{behavior:'deny', message:'Turn cancelled'}` from the reason.

- [ ] **Step 4: Wire the signal and interrupt**

At the top of `canUseTool`, before parking:

```ts
      options.signal.addEventListener('abort', () => { cancelParked(id); }, { once: true });
```

In `interrupt` (line 639), before forwarding:

```ts
      interrupt: async () => {
        for (const id of [...parked.keys()]) { cancelParked(id); }
        if (!queryRef) { return; }
        try {
          await queryRef.interrupt();
        } catch (err) {
          events.push({ kind: 'turn-end', reason: 'error', error: errorMessage(err) });
        }
      },
```

- [ ] **Step 5: Run the tests**

Run: `yarn test:unit --grep "ClaudeProvider"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/providers/claude/claude-provider.ts src/test/unit/claude-provider.test.ts
git commit -m "fix: settle parked tool requests when a turn is cancelled"
```

---

### Task 5: Claude — carry permission metadata (Tier A)

**Files:**
- Modify: `src/providers/claude/claude-provider.ts` (`canUseTool`'s permission branch)
- Test: `src/test/unit/claude-provider.test.ts`

**Interfaces:**
- Consumes: `PermissionMeta` (Task 2).
- Produces: `{kind:'permission'}` events carrying `meta`.

- [ ] **Step 1: Write the failing test**

```ts
  test('a permission event carries the bridge-rendered title and reason', async () => {
    const { queryFn, calls } = fakeLoadQuery();
    const provider = new ClaudeProvider(async () => queryFn);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    const events = collect(run);
    run.send('hi');
    await tick();

    const canUseTool = calls[0].options.canUseTool as CanUseToolLike;
    void canUseTool('Read', { file_path: '/tmp/a' }, {
      toolUseID: 't1', signal: new AbortController().signal, requestId: 'rq1',
      title: 'Claude wants to read a.txt', displayName: 'Read file',
      description: 'Read access to /tmp', decisionReason: 'outside allowed directories',
      blockedPath: '/tmp/a',
    });
    await tick();

    const p = events().find((e) => e.kind === 'permission');
    assert.strictEqual(p?.kind, 'permission');
    assert.strictEqual(p.meta?.title, 'Claude wants to read a.txt');
    assert.strictEqual(p.meta?.decisionReason, 'outside allowed directories');
    assert.strictEqual(p.meta?.blockedPath, '/tmp/a');
  });

  test('a permission event omits meta entirely when the bridge sends none', async () => {
    const { queryFn, calls } = fakeLoadQuery();
    const provider = new ClaudeProvider(async () => queryFn);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    const events = collect(run);
    run.send('hi');
    await tick();

    const canUseTool = calls[0].options.canUseTool as CanUseToolLike;
    void canUseTool('Read', { file_path: '/tmp/a' },
      { toolUseID: 't1', signal: new AbortController().signal, requestId: 'rq1' });
    await tick();

    const p = events().find((e) => e.kind === 'permission');
    assert.strictEqual(p?.kind, 'permission');
    assert.strictEqual(p.meta === undefined, true);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test:unit --grep "bridge-rendered title"`
Expected: FAIL — `meta` is undefined.

- [ ] **Step 3: Build meta from the options bag**

In `map-questions.ts` (it is the mapper module for this provider's non-tool payloads; keep it here rather than adding a file):

```ts
import type { PermissionMeta } from '../types';

/**
 * The permission engine's own account of a request. Everything here is
 * already rendered by the bridge — the SDK says to prefer `title` over
 * reconstructing a sentence from toolName+input. Returns undefined rather
 * than an empty object so the event omits the key entirely.
 */
export function toPermissionMeta(options: {
  title?: string; displayName?: string; description?: string;
  decisionReason?: string; blockedPath?: string;
}): PermissionMeta | undefined {
  const meta: PermissionMeta = {};
  if (options.title !== undefined) { meta.title = options.title; }
  if (options.displayName !== undefined) { meta.displayName = options.displayName; }
  if (options.description !== undefined) { meta.description = options.description; }
  if (options.decisionReason !== undefined) { meta.decisionReason = options.decisionReason; }
  if (options.blockedPath !== undefined) { meta.blockedPath = options.blockedPath; }
  return Object.keys(meta).length > 0 ? meta : undefined;
}
```

In the permission branch of `canUseTool`:

```ts
      const meta = toPermissionMeta(options);
      events.push({ kind: 'permission', id, tool: toToolCall(toolName, input), ...(meta ? { meta } : {}) });
```

- [ ] **Step 4: Run the tests**

Run: `yarn test:unit --grep "ClaudeProvider"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/claude/map-questions.ts src/providers/claude/claude-provider.ts src/test/unit/claude-provider.test.ts
git commit -m "feat: carry permission metadata from the Claude bridge"
```

---

### Task 6: Codex — answer `item/tool/requestUserInput`

**Files:**
- Modify: `src/providers/codex/wire.ts` (request params types)
- Modify: `src/providers/codex/map-events.ts:16` (`DECLINED_INPUT_METHODS`)
- Modify: `src/providers/codex/codex-run.ts:201-230`
- Test: `src/test/unit/codex-run.test.ts:230` — **rewrite** the existing test that asserts the decline
- Reference: `.codex-bindings/v2/ToolRequestUserInput*.ts` (regenerate with `yarn codex:bindings`)

**Interfaces:**
- Consumes: `QuestionSpec`, `QuestionAnswers` (Task 2).
- Produces: `CodexRun` emitting `{kind:'question'}` and honouring `respondToQuestion`, responding `{answers: {[id]: {answers: [...]}}}`.

- [ ] **Step 1: Add the request wire types**

`wire.ts` currently defines only the response. Add the params, verified against codex-cli 0.147.0 bindings:

```ts
/**
 * `item/tool/requestUserInput`'s params — verified against the codex-cli
 * 0.147.0 generated bindings (`ToolRequestUserInputParams`). EXPERIMENTAL
 * upstream. `autoResolutionMs` is deprecated in favour of `isBlocking` and
 * is deliberately not mapped.
 */
export interface ToolRequestUserInputOption { label: string; description: string }
export interface ToolRequestUserInputQuestion {
  id: string; header: string; question: string;
  isOther: boolean; isSecret: boolean;
  options: ToolRequestUserInputOption[] | null;
}
export interface ToolRequestUserInputParams {
  threadId: string; turnId: string; itemId: string;
  questions: ToolRequestUserInputQuestion[];
  isBlocking: boolean;
}
```

- [ ] **Step 2: Rewrite the failing test**

Replace the existing test at `src/test/unit/codex-run.test.ts:230` (currently asserting the decline) with:

```ts
  test('a requestUserInput becomes a question event, not a decline', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    send({
      id: 44, method: 'item/tool/requestUserInput',
      params: {
        threadId: 'th_1', turnId: 'tu_1', itemId: 'it_1', isBlocking: true,
        questions: [{
          id: 'q1', header: 'Scope', question: 'Which one?',
          isOther: true, isSecret: false,
          options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }],
        }],
      },
    });
    await tick();

    const q = events().find((e) => e.kind === 'question');
    assert.strictEqual(q?.kind, 'question');
    assert.strictEqual(q.blocking, true);
    assert.strictEqual(q.questions[0].id, 'q1');
    assert.strictEqual(q.questions[0].allowOther, true);
    assert.strictEqual(q.questions[0].secret, false);
    // Nothing is answered yet — the request stays parked.
    assert.strictEqual(sent().some((f) => f.id === 44), false);
  });

  test('respondToQuestion answers the parked request in codex shape', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    send({
      id: 44, method: 'item/tool/requestUserInput',
      params: {
        threadId: 'th_1', turnId: 'tu_1', itemId: 'it_1', isBlocking: true,
        questions: [{ id: 'q1', header: 'H', question: 'Q?', isOther: false, isSecret: false,
          options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }],
      },
    });
    await tick();

    const q = events().find((e) => e.kind === 'question');
    run.respondToQuestion(q!.id, { q1: ['A', 'B'] });
    await tick();

    assert.deepStrictEqual(sent().at(-1),
      { id: 44, result: { answers: { q1: { answers: ['A', 'B'] } } } });
  });

  test('a question with null options maps to a free-text question', async () => {
    const { server, send } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    send({
      id: 45, method: 'item/tool/requestUserInput',
      params: {
        threadId: 'th_1', turnId: 'tu_1', itemId: 'it_1', isBlocking: false,
        questions: [{ id: 'q1', header: 'H', question: 'Name?', isOther: true, isSecret: true, options: null }],
      },
    });
    await tick();

    const q = events().find((e) => e.kind === 'question');
    assert.strictEqual(q?.kind, 'question');
    assert.strictEqual(q.blocking, false);
    assert.strictEqual(q.questions[0].options === undefined, true);
    assert.strictEqual(q.questions[0].secret, true);
  });

  test('an MCP elicitation is still declined with an action', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    collect(run);
    send({ id: 48, method: 'mcpServer/elicitation/request', params: { threadId: 'th_1' } });
    await tick();
    assert.deepStrictEqual(sent().at(-1),
      { id: 48, result: { action: 'decline', content: null, _meta: null } });
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `yarn test:unit --grep "requestUserInput|respondToQuestion|free-text question"`
Expected: FAIL — the method is still in `DECLINED_INPUT_METHODS`.

- [ ] **Step 4: Map and park**

In `map-events.ts`, narrow the decline list and add a mapper:

```ts
export const DECLINED_INPUT_METHODS = [
  'mcpServer/elicitation/request',
];

/**
 * `item/tool/requestUserInput` -> a neutral question event. Codex declares no
 * multi-select: the response is an array, but nothing says more than one value
 * is permitted, so v1 maps single-select. See the spec's Open Item 2.
 */
export function questionEventOf(id: string | number, params: ToolRequestUserInputParams): AgentEvent {
  return {
    kind: 'question',
    id: String(id),
    blocking: params.isBlocking,
    questions: params.questions.map((q) => ({
      id: q.id,
      header: q.header,
      question: q.question,
      ...(q.options ? { options: q.options.map((o) => ({ label: o.label, description: o.description })) } : {}),
      multiSelect: false,
      allowOther: q.isOther,
      secret: q.isSecret,
    })),
  };
}
```

In `codex-run.ts`'s `onServerRequest`, before the `DECLINED_INPUT_METHODS` branch:

```ts
      if (method === 'item/tool/requestUserInput') {
        const event = questionEventOf(id, params as ToolRequestUserInputParams);
        this.pendingQuestions.set(event.id, id);
        this.events.push(event);
        return;
      }
```

Add the map beside `pendingApprovals`, and implement the responder:

```ts
  private pendingQuestions = new Map<string, string | number>();

  respondToQuestion(id: string, answers: QuestionAnswers): void {
    const rpcId = this.pendingQuestions.get(id);
    if (rpcId === undefined) { return; }
    this.pendingQuestions.delete(id);
    const mapped: ToolRequestUserInputResponse = { answers: {} };
    for (const [qid, values] of Object.entries(answers)) { mapped.answers[qid] = { answers: values }; }
    this.server.respond(rpcId, mapped);
  }
```

- [ ] **Step 5: Cancel parked questions on interrupt and dispose**

Wherever `CodexRun` interrupts or disposes, answer any parked question with the structurally-valid empty map and report the cancellation, mirroring Task 4:

```ts
  private cancelParkedQuestions(): void {
    for (const [id, rpcId] of this.pendingQuestions) {
      this.server.respond(rpcId, { answers: {} } satisfies ToolRequestUserInputResponse);
      this.events.push({ kind: 'request-cancelled', id });
    }
    this.pendingQuestions.clear();
  }
```

- [ ] **Step 6: Run the tests and commit**

Run: `yarn test:unit --grep "CodexRun" && yarn lint && yarn check-types`
Expected: PASS.

```bash
git add src/providers/codex/wire.ts src/providers/codex/map-events.ts src/providers/codex/codex-run.ts src/test/unit/codex-run.test.ts
git commit -m "feat: answer codex requestUserInput instead of declining it"
```

---

### Task 7: Host — park, answer and cancel questions

**Files:**
- Modify: `src/host/agent-session.ts` (fields near line 94, event switch near line 590, responder near line 320, `dispose` near line 467, snapshot near line 454)
- Modify: `src/host/message-router.ts`
- Test: `src/test/unit/agent-session.test.ts`, `src/test/unit/message-router.test.ts`

**Interfaces:**
- Consumes: the `question` / `request-cancelled` events (Tasks 3, 4, 6); `QuestionRequest` (Task 2).
- Produces: `AgentSession.answerQuestion(requestId: string, answers: QuestionAnswers): void`; snapshots carrying `pendingQuestions`.

- [ ] **Step 1: Write the failing tests**

```ts
suite('AgentSession questions', () => {
  test('a question event appends a pending item and records the request', async () => {
    const { session, provider } = await sessionWith();
    provider.emit({ kind: 'question', id: 'r1', blocking: true, questions: [SPEC] });
    await tick();

    const state = await session.snapshot();
    const item = state.items.at(-1);
    assert.strictEqual(item?.role, 'question');
    assert.strictEqual(item.state, 'pending');
    assert.strictEqual(state.pendingQuestions.length, 1);
    assert.strictEqual(state.pendingQuestions[0].requestId, 'r1');
  });

  test('answering replaces the item and calls the provider once', async () => {
    const { session, provider } = await sessionWith();
    provider.emit({ kind: 'question', id: 'r1', blocking: true, questions: [SPEC] });
    await tick();

    session.answerQuestion('r1', { q1: ['A'] });
    session.answerQuestion('r1', { q1: ['B'] });
    await tick();

    assert.deepStrictEqual(provider.answered, [['r1', { q1: ['A'] }]]);
    const state = await session.snapshot();
    assert.strictEqual(state.items.at(-1)?.state, 'answered');
    assert.strictEqual(state.pendingQuestions.length, 0);
  });

  test('a cancellation marks the card cancelled', async () => {
    const { session, provider } = await sessionWith();
    provider.emit({ kind: 'question', id: 'r1', blocking: true, questions: [SPEC] });
    await tick();
    provider.emit({ kind: 'request-cancelled', id: 'r1' });
    await tick();

    const state = await session.snapshot();
    assert.strictEqual(state.items.at(-1)?.state, 'cancelled');
    assert.strictEqual(state.pendingQuestions.length, 0);
  });
});
```

Define the shared fixture in the same file:

```ts
const SPEC = {
  id: 'q1', header: 'H', question: 'Q?', multiSelect: false,
  allowOther: true, secret: false,
  options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
};
```

And in `src/test/unit/message-router.test.ts`:

```ts
  test('question-answer reaches the addressed session', () => {
    const { router, calls } = routerWith('a');
    router.handle({ t: 'question-answer', id: 'a', requestId: 'r1', answers: { q1: ['A'] } });
    assert.deepStrictEqual(calls, [['answerQuestion', 'r1', { q1: ['A'] }]]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test:unit --grep "AgentSession questions|question-answer reaches"`
Expected: FAIL — `answerQuestion` does not exist.

- [ ] **Step 3: Add the field, handlers and responder**

Beside `pending` (line 94):

```ts
  private pendingQuestions = new Map<string, QuestionRequest>();
```

In the event switch, beside the `permission` case (line 590):

```ts
      case 'question': {
        const item: TranscriptItem = {
          id: nextId('q'), ts: Date.now(), role: 'question',
          requestId: event.id, questions: event.questions, blocking: event.blocking,
          state: 'pending',
        };
        this.append(item, event.parentId);
        this.pendingQuestions.set(event.id, {
          requestId: event.id, questions: event.questions, blocking: event.blocking,
        });
        this.setStatus('awaiting-approval');
        return;
      }
      case 'request-cancelled': {
        this.settleRequest(event.id, 'cancelled');
        return;
      }
```

The responder, beside the permission one (line 320):

```ts
  answerQuestion(requestId: string, answers: QuestionAnswers): void {
    const request = this.pendingQuestions.get(requestId);
    // Already answered or cancelled: a no-op, not a failure. Mirrors the
    // permission responder's early return, which is what stops a second
    // click from stranding the card with no way to retry.
    if (!request) { return; }
    this.pendingQuestions.delete(requestId);
    this.replaceQuestionItem(requestId, 'answered', persistableAnswers(request.questions, answers));
    this.run.respondToQuestion(requestId, answers);
    this.recomputeWaitingStatus();
  }
```

`settleRequest(id, state)` looks the id up in `pending` first and `pendingQuestions` second, replaces the matching item, and recomputes status. `recomputeWaitingStatus()` replaces the three existing inline `this.setStatus(this.pending.size > 0 ? … : …)` sites (lines 353, 644) with one that accounts for both maps:

```ts
  private recomputeWaitingStatus(idle: SessionStatus = 'running'): void {
    const waiting = this.pending.size > 0 || this.pendingQuestions.size > 0;
    this.setStatus(waiting ? 'awaiting-approval' : idle);
  }
```

`dispose()` (line 467) settles parked questions the way it settles permissions:

```ts
    for (const requestId of [...this.pendingQuestions.keys()]) {
      this.pendingQuestions.delete(requestId);
      try {
        this.run.respondToQuestion(requestId, {});
      } catch {
        // Best-effort: the provider is being torn down regardless.
      }
    }
```

The snapshot (line 454) gains `pendingQuestions: [...this.pendingQuestions.values()]`.

- [ ] **Step 4: Route the message**

In `src/host/message-router.ts`, beside the `permission-decision` case:

```ts
      case 'question-answer':
        this.sessions.get(msg.id)?.answerQuestion(msg.requestId, msg.answers);
        return;
```

- [ ] **Step 5: Run the tests and commit**

Run: `yarn test:unit && yarn lint && yarn check-types`
Expected: PASS.

```bash
git add src/host/agent-session.ts src/host/message-router.ts src/test/unit/agent-session.test.ts src/test/unit/message-router.test.ts
git commit -m "feat: park and answer questions in the host session"
```

---

### Task 8: Host — secret answers and `stale` on read

**Files:**
- Create: `src/host/question-persistence.ts`
- Modify: `src/host/session-manager.ts` (the transcript read path that already maps `relocation`'s `queued` → `pending`)
- Test: `src/test/unit/agent-session.test.ts`, `src/test/unit/session-manager.test.ts`

**Interfaces:**
- Consumes: `QuestionSpec`, `QuestionAnswers` (Task 2); `answerQuestion` (Task 7).
- Produces: `persistableAnswers(questions: QuestionSpec[], answers: QuestionAnswers): QuestionAnswers` — used by Task 7's responder.

- [ ] **Step 1: Write the failing tests**

The secret test asserts against the written JSONL, not the in-memory item. That is the only version that can catch a credential reaching disk.

```ts
  test("a secret answer's value never reaches the transcript file", async () => {
    const { session, provider, storeDir, sessionId } = await sessionWith();
    provider.emit({ kind: 'question', id: 'r1', blocking: true, questions: [{
      id: 'q1', header: 'Token', question: 'API token?', multiSelect: false,
      allowOther: true, secret: true,
    }] });
    await tick();

    session.answerQuestion('r1', { q1: ['sk-super-secret-value'] });
    await tick();
    await session.flush();

    const jsonl = await fs.readFile(path.join(storeDir, `${sessionId}.jsonl`), 'utf8');
    assert.strictEqual(jsonl.includes('sk-super-secret-value'), false);
    assert.strictEqual(jsonl.includes('"state":"answered"'), true);
  });

  test('a non-secret answer is persisted in full', async () => {
    const { session, provider, storeDir, sessionId } = await sessionWith();
    provider.emit({ kind: 'question', id: 'r1', blocking: true, questions: [SPEC] });
    await tick();
    session.answerQuestion('r1', { q1: ['A'] });
    await tick();
    await session.flush();

    const jsonl = await fs.readFile(path.join(storeDir, `${sessionId}.jsonl`), 'utf8');
    assert.strictEqual(jsonl.includes('"q1":["A"]'), true);
  });
```

And in `src/test/unit/session-manager.test.ts`:

```ts
  test('a pending question with no live request reads back as stale', async () => {
    const { manager, storeDir, sessionId } = await managerWithTranscript([
      { id: 'q1', ts: 1, role: 'question', requestId: 'r1', blocking: true,
        questions: [SPEC], state: 'pending' },
    ]);

    const state = await manager.snapshot(sessionId);
    assert.strictEqual(state.items.at(-1)?.state, 'stale');

    // The file is not rewritten — the JSONL keeps what was written.
    const jsonl = await fs.readFile(path.join(storeDir, `${sessionId}.jsonl`), 'utf8');
    assert.strictEqual(jsonl.includes('"state":"pending"'), true);
    assert.strictEqual(jsonl.includes('"state":"stale"'), false);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test:unit --grep "secret answer|reads back as stale"`
Expected: FAIL — the secret value is written, and a restored pending question stays `pending`.

- [ ] **Step 3: Write the redaction helper**

Create `src/host/question-persistence.ts`:

```ts
import type { QuestionAnswers, QuestionSpec } from '../providers/types';

/**
 * The answers safe to write to the transcript JSONL.
 *
 * A question may declare its answer secret. Transcripts are durable files
 * under `context.storageUri`, so persisting one verbatim turns the panel into
 * a plaintext credential store. The key is dropped entirely rather than
 * replaced with a placeholder: combined with `state: 'answered'` on the item,
 * a missing key for a `secret` question reads as "asked, answered,
 * deliberately not recorded", and there is no fake value to mistake for real.
 */
export function persistableAnswers(
  questions: QuestionSpec[],
  answers: QuestionAnswers,
): QuestionAnswers {
  const secrets = new Set(questions.filter((q) => q.secret).map((q) => q.id));
  if (secrets.size === 0) { return answers; }
  const out: QuestionAnswers = {};
  for (const [id, values] of Object.entries(answers)) {
    if (!secrets.has(id)) { out[id] = values; }
  }
  return out;
}
```

Note the ordering requirement in `answerQuestion` (Task 7): the **unredacted** answers go to `run.respondToQuestion`, the **redacted** ones go into the transcript item. Getting these the wrong way round either leaks the secret or sends the agent an empty answer.

- [ ] **Step 4: Map `stale` on read**

In `src/host/session-manager.ts`, in the same read path that maps `relocation`'s `queued` → `pending`, add:

```ts
      // A question parked in a previous host process. The SDK call it belonged
      // to died with that process, so it can never be answered — but the file
      // is not rewritten, exactly as for relocation: the JSONL keeps what was
      // written and the restart-dependent reading is applied here.
      if (item.role === 'question' && item.state === 'pending'
          && !live.pendingQuestions.some((q) => q.requestId === item.requestId)) {
        return { ...item, state: 'stale' as const };
      }
```

- [ ] **Step 5: Run the tests and commit**

Run: `yarn test:unit && yarn lint && yarn check-types`
Expected: PASS.

```bash
git add src/host/question-persistence.ts src/host/agent-session.ts src/host/session-manager.ts src/test/unit/agent-session.test.ts src/test/unit/session-manager.test.ts
git commit -m "feat: redact secret answers and stale orphaned questions"
```

---

### Task 9: Webview — reducer slice and fixtures

**Files:**
- Modify: `src/webview/reducer.ts:300-340`
- Modify: `src/test/fixtures/protocol.ts`
- Test: `src/test/unit/webview-reducer.test.ts`

**Interfaces:**
- Consumes: the `question` transcript role and `SessionState.pendingQuestions` (Task 2).
- Produces: `ClientState`'s per-session `pendingQuestions: QuestionRequest[]`; a `question(over?)` fixture returning a `QuestionItem`.

- [ ] **Step 1: Add the fixture**

In `src/test/fixtures/protocol.ts`, beside `permission()` (line 94):

```ts
export function question(over: Partial<QuestionItem> = {}): QuestionItem {
  return {
    id: 'q1', ts: 1, role: 'question', requestId: 'r1', blocking: true,
    state: 'pending',
    questions: [{
      id: 'qq1', header: 'Scope', question: 'Which one?',
      multiSelect: false, allowOther: true, secret: false,
      options: [
        { label: 'Question cards only', description: 'Smaller blast radius' },
        { label: 'Both in one spec', description: 'Shares the call site' },
      ],
    }],
    ...over,
  };
}
```

- [ ] **Step 2: Write the failing tests**

```ts
  test('an appended pending question registers as pending', () => {
    let state = reduce(initial(), hydrateMsg());
    state = reduce(state, { t: 'transcript-patch', id: 'a', patch: { op: 'append', item: question() } });
    assert.strictEqual(state.sessions.a.pendingQuestions.length, 1);
  });

  test('replacing it with an answered item clears the pending entry', () => {
    let state = reduce(initial(), hydrateMsg());
    state = reduce(state, { t: 'transcript-patch', id: 'a', patch: { op: 'append', item: question() } });
    state = reduce(state, { t: 'transcript-patch', id: 'a',
      patch: { op: 'replace', item: question({ state: 'answered', answers: { qq1: ['A'] } }) } });
    assert.strictEqual(state.sessions.a.pendingQuestions.length, 0);
  });

  test('hydrate seeds pending questions', () => {
    const state = reduce(initial(), hydrateMsg({ pendingQuestions: [
      { requestId: 'r1', blocking: true, questions: question().questions },
    ] }));
    assert.strictEqual(state.sessions.a.pendingQuestions.length, 1);
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `yarn test:unit --grep "pending question"`
Expected: FAIL — `pendingQuestions` is not on the client state.

- [ ] **Step 4: Mirror the permission handling**

In `reducer.ts`, alongside the two existing lines (310, 329):

```ts
      const pendingQ = patch.item.role === 'question' && patch.item.state === 'pending'
```

for `append`, and the `state !== 'pending'` form for `replace`. Seed from `SessionState.pendingQuestions` in the hydrate branch.

- [ ] **Step 5: Run the tests and commit**

Run: `yarn test:unit --grep "reducer" && yarn lint && yarn check-types`
Expected: PASS.

```bash
git add src/webview/reducer.ts src/test/fixtures/protocol.ts src/test/unit/webview-reducer.test.ts
git commit -m "feat: track pending questions in the webview reducer"
```

---

### Task 10: Webview — the question card

The largest task. Vendoring is folded in because the card cannot be built without it.

**Files:**
- Create: `src/webview/components/ui/checkbox.tsx` (vendored)
- Create: `src/webview/components/ui/input.tsx` (vendored — only `input-group.tsx` exists today; check whether it already re-exports an `Input` before vendoring a second one)
- Create: `src/webview/components/question-card.tsx`
- Modify: `src/webview/components/transcript-item.tsx` (render the new role)
- Test: `src/test/dom/question-card.test.tsx`

**Interfaces:**
- Consumes: `pendingQuestions` (Task 9); the `question-answer` message (Task 2).
- Produces: `QuestionCard({ item, sessionId })`, posting `{t:'question-answer', id, requestId, answers}`.

- [ ] **Step 1: Vendor the primitives**

Use the shadcn MCP tools to fetch the Base UI-backed `checkbox` (and `input` if absent) into `src/webview/components/ui/`. Do not hand-roll either, and do not pull Radix packages — the registry is `@base-ui/react`. Tailwind picks new files up through the esbuild plugin; no config change.

- [ ] **Step 2: Write the failing tests**

```ts
import { QuestionCard } from '@/components/question-card';
import { catalog, layoutOf, question, snapshot, summary } from '../fixtures/protocol';
import { posted, renderWithStore, sendFromHost } from './harness';

function hydrateWith(pendingQuestions: QuestionRequest[]) {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a')],
    layout: layoutOf('a'),
    snapshots: [snapshot('a', { pendingQuestions })],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

const LIVE = [{ requestId: 'r1', blocking: true, questions: question().questions }];

suite('QuestionCard', () => {
  test('a single question renders no stepper', () => {
    renderWithStore(<QuestionCard item={question()} sessionId="a" />);
    hydrateWith(LIVE);
    assert.strictEqual(screen.queryByText('1 of 1') === null, true);
    assert.strictEqual(screen.getByLabelText('Answer').textContent.length > 0, true);
  });

  test('choosing an option and answering posts the answers keyed by question id', async () => {
    renderWithStore(<QuestionCard item={question()} sessionId="a" />);
    hydrateWith(LIVE);

    await userEvent.click(screen.getByLabelText('Question cards only'));
    await userEvent.click(screen.getByLabelText('Answer'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'question-answer', id: 'a', requestId: 'r1',
      answers: { qq1: ['Question cards only'] },
    });
  });

  test('three questions step forward and post one message carrying all three', async () => {
    const item = question({ questions: [q('a1'), q('a2'), q('a3')] });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    assert.strictEqual(screen.getByText('1 of 3').textContent, '1 of 3');
    await userEvent.click(screen.getByLabelText('A'));
    await userEvent.click(screen.getByLabelText('Next'));
    await userEvent.click(screen.getByLabelText('A'));
    await userEvent.click(screen.getByLabelText('Next'));
    await userEvent.click(screen.getByLabelText('A'));
    await userEvent.click(screen.getByLabelText('Answer'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'question-answer', id: 'a', requestId: 'r1',
      answers: { a1: ['A'], a2: ['A'], a3: ['A'] },
    });
  });

  test('a multiSelect question posts every checked value', async () => {
    const item = question({ questions: [{ ...question().questions[0], multiSelect: true }] });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    await userEvent.click(screen.getByLabelText('Question cards only'));
    await userEvent.click(screen.getByLabelText('Both in one spec'));
    await userEvent.click(screen.getByLabelText('Answer'));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'question-answer', id: 'a', requestId: 'r1',
      answers: { qq1: ['Question cards only', 'Both in one spec'] },
    });
  });

  test('a question with no options renders a text field only', () => {
    const item = question({ questions: [{
      id: 'qq1', header: 'Name', question: 'Name?', multiSelect: false,
      allowOther: true, secret: false,
    }] });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    assert.strictEqual(screen.queryByRole('radio') === null, true);
    assert.strictEqual(screen.getByLabelText('Your answer').tagName.length > 0, true);
  });

  test('a secret question masks its field', () => {
    const item = question({ questions: [{
      id: 'qq1', header: 'Token', question: 'API token?', multiSelect: false,
      allowOther: true, secret: true,
    }] });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    assert.strictEqual(
      (screen.getByLabelText('Your answer') as HTMLInputElement).type, 'password');
  });

  test('a preview is collapsed until its disclosure is opened', async () => {
    const item = question({ questions: [{
      ...question().questions[0],
      options: [
        { label: 'A', description: 'a', preview: 'PREVIEW BODY' },
        { label: 'B', description: 'b' },
      ],
    }] });
    renderWithStore(<QuestionCard item={item} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: item.questions }]);

    assert.strictEqual(screen.queryByText('PREVIEW BODY') === null, true);
    await userEvent.click(screen.getByLabelText('Show preview for A'));
    assert.strictEqual(screen.getByText('PREVIEW BODY').textContent, 'PREVIEW BODY');
  });

  test('cancelled and stale cards offer no controls', () => {
    renderWithStore(<QuestionCard item={question({ state: 'stale' })} sessionId="a" />);
    hydrateWith([]);
    assert.strictEqual(screen.queryByLabelText('Answer') === null, true);
  });
});
```

Add the local helper used above:

```ts
function q(id: string) {
  return {
    id, header: 'H', question: `${id}?`, multiSelect: false, allowOther: false, secret: false,
    options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
  };
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `yarn test:dom --grep "QuestionCard"`
Expected: FAIL — the module does not exist.

- [ ] **Step 4: Build the card**

`src/webview/components/question-card.tsx`. Requirements, all covered by the tests above:

- Local state only: `step`, `selections: Record<string, string[]>`, `other: Record<string, string>`. Nothing durable — a reshown panel rebuilds from `pendingQuestions` and the user re-picks.
- Stepper chrome (`n of m`, Back, Next) only when `questions.length > 1`; a single question shows Answer alone.
- `options` present → `RadioGroup`, or `Checkbox` list when `multiSelect`. Absent → text field only.
- `allowOther` adds a text field alongside the options; `secret` makes that field masked (`type="password"`).
- `preview` renders through `markdown.tsx` inside a collapsed disclosure labelled `Show preview for {label}`.
- Answer posts one `question-answer` with every question's values; Cancel posts the existing interrupt message.
- Non-`pending` states (`answered`, `cancelled`, `stale`) render read-only, showing the outcome.
- Compose classNames with `cn`; use short token utilities (`border-border`, `bg-muted`, `text-muted-foreground`).

Register the role in `transcript-item.tsx` beside `permission` and `relocation`.

- [ ] **Step 5: Run the tests**

Run: `yarn test:dom --grep "QuestionCard" && yarn lint && yarn check-types`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/webview/components/ui/ src/webview/components/question-card.tsx src/webview/components/transcript-item.tsx src/test/dom/question-card.test.tsx
git commit -m "feat: render and answer question cards in the panel"
```

---

### Task 11: Webview — block the composer for blocking questions

**Files:**
- Modify: `src/webview/components/composer.tsx:75, 205-210, 290, 415`
- Test: `src/test/dom/composer.test.tsx`

**Interfaces:**
- Consumes: `pendingQuestions` (Task 9).
- Produces: no new symbols; the composer's existing disabled-with-a-reason contract extended to a new cause.

- [ ] **Step 1: Write the failing tests**

```ts
  test('a blocking question disables the composer with a visible reason', () => {
    renderWithStore(<Composer pane={pane('a')} />);
    hydrateWith([{ requestId: 'r1', blocking: true, questions: question().questions }]);

    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
    assert.strictEqual(box.disabled, true);
    assert.strictEqual(box.getAttribute('aria-describedby')?.length ?? 0 > 0, true);
    assert.strictEqual(screen.getByText('Answer the question above to continue.').textContent.length > 0, true);
  });

  test('a non-blocking question leaves the composer usable', () => {
    renderWithStore(<Composer pane={pane('a')} />);
    hydrateWith([{ requestId: 'r1', blocking: false, questions: question().questions }]);

    assert.strictEqual((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled, false);
  });

  test('a pending permission still leaves the composer usable', () => {
    renderWithStore(<Composer pane={pane('a')} />);
    hydrateWithPermission([{ requestId: 'r1', tool: permission().tool }]);

    assert.strictEqual((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled, false);
  });
```

The third test pins existing behaviour that must not change: permissions block the agent, not the user.

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test:dom --grep "blocking question|non-blocking question"`
Expected: FAIL — the composer ignores questions.

- [ ] **Step 3: Extend the reason, do not overload `readOnly`**

`readOnly` (line 75) means provider unavailability. Add a second, separately-named cause so the reason line can say which one applies:

```ts
  const blockedByQuestion = pendingQuestions.some((q) => q.blocking);
  const blockedReason = unavailableReason
    ?? (blockedByQuestion ? 'Answer the question above to continue.' : undefined);
  const disabled = blockedReason !== undefined;
```

Then use `disabled` / `blockedReason` at the existing sites (290, 355, 362, 415), keeping the contract the file already documents: one visible reason line, `aria-describedby` pointing at it, **never** a `title` — a `title` on a disabled element reaches neither keyboard focus nor most screen readers.

- [ ] **Step 4: Run the tests and commit**

Run: `yarn test:dom && yarn lint && yarn check-types`
Expected: PASS.

```bash
git add src/webview/components/composer.tsx src/test/dom/composer.test.tsx
git commit -m "feat: block the composer while a blocking question is pending"
```

---

### Task 12: Quality gate

**Files:**
- Modify: whatever the detector and critique findings require, under `src/webview/components/`

**Interfaces:**
- Consumes: every webview file from Tasks 10 and 11.
- Produces: a clean detector run and a critique score no lower than the previous one.

- [ ] **Step 1: Run the mechanical detector**

Run: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/question-card.tsx src/webview/components/composer.tsx src/webview/components/transcript-item.tsx`
Expected: exit 0. Exit 2 means findings — a failing check, not a suggestion.

- [ ] **Step 2: Fix any findings and re-run**

Repeat until exit 0.

- [ ] **Step 3: Run critique over the webview**

Invoke the `impeccable` skill's `critique` over `src/webview`, comparing against the previous run in `.impeccable/critique/`. The score is expected to go up, never down.

**This must be run by the controller, not by a task implementer.** Critique requires two isolated subagents (Assessment A design review, Assessment B detector evidence), and an implementer dispatch carries a no-subagents contract — a single-context run is a failed critique by the skill's own definition.

Remember the mode: this panel is **Operate**, not Persuade. A 300-500px sidebar during a long-running turn. Scanability and native VS Code expectations outrank expression.

- [ ] **Step 4: Full verification**

Run: `yarn lint && yarn check-types && yarn run compile && yarn test:unit && yarn test:dom`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: address impeccable findings on the question card"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: Decisions 1-2 → Task 2; Decision 3 → Task 4 (Claude) and Task 6 Step 5 (codex); Decision 4 → Task 8; Decision 5 → Task 8; Decision 6 → Task 11; Decision 7 → Task 10. Provider mapping table → Tasks 3, 5, 6. Host section → Tasks 7-8. Webview section → Tasks 9-11. Testing section → distributed across each task. Open Item 1 → Task 1. Open Item 2 → Task 6 Step 4's comment, which records the v1 choice and points back at the spec.

**Type consistency.** `QuestionSpec` / `QuestionAnswers` / `QuestionRequest` / `PermissionMeta` are declared once in Task 2 and used unchanged after. `respondToQuestion(id, answers)` is the provider method throughout; `answerQuestion(requestId, answers)` is the host method throughout. `persistableAnswers` is produced in Task 8 and consumed by Task 7's responder — implement Task 7's `answerQuestion` against the signature declared in Task 8, or take the two tasks together.

**Known ordering wrinkle.** Task 7 references `persistableAnswers`, which Task 8 creates. If tasks are executed strictly in order, Task 7 should inline an identity function and Task 8 replaces it; the alternative is to run 7 and 8 as one unit. Flagged rather than hidden.

## Deferred (not in this plan)

- Tier B "always allow" via permission `suggestions` — needs a third `ToolDecision` variant, a `PermissionUpdate` mirror that keeps the SDK out of the webview bundle, and a `PermissionUpdateDestination` decision. Recorded in project memory as `permission-suggestions-unused`.
- MCP elicitation (`mcpServer/elicitation/request`) — a JSON-schema-driven form, stays declined.
- Dismissing a question without cancelling the turn.
