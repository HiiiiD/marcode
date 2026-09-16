# Session Token Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track cumulative input/output/cache-read/cache-write token totals
per session, split into `normal` vs `subagent` buckets where the provider's
data can actually back it, persisted through the existing `index.json` path
and shown in the context dialog.

**Architecture:** A shared `UsageTotals` shape lives in `src/providers/types.ts`
and a pure `src/shared/usage-totals.ts` does the arithmetic. Each provider
adapter (Claude, Codex, ACP) is responsible for turning its own native usage
signal — a per-turn delta or an already-cumulative snapshot — into a running
cumulative `UsageTotals` before it ever reaches `AgentEvent`; the host
(`agent-session.ts`) just assigns the latest event's totals, no summing at
that layer. Only Codex's data can back a `subagent` split, so only Codex ever
sets that field.

**Tech Stack:** TypeScript, mocha (`yarn test:unit`), React 19 + `@testing-library/react` (`yarn test:dom`).

**Spec:** [docs/superpowers/specs/2026-09-15-session-token-usage-design.md](../specs/2026-09-15-session-token-usage-design.md)

## Global Constraints

- `subagent` totals are only ever set by the Codex adapter. Claude and ACP
  never set that field — never a faked zero standing in for "can't tell."
- `SessionState.usage` stays `undefined` until a session's first `usage`
  event — never defaulted to zeros at session creation.
- `UsageTotals`'s four fields (`inputTokens`, `outputTokens`,
  `cacheReadTokens`, `cacheCreationTokens`) are all required numbers. A
  provider with no concept of a field (Codex has no cache-creation billing;
  ACP has neither cache field) reports it as a real `0`, which is a true
  statement about that protocol, not a stand-in for "unmeasured."
- No `TRANSCRIPT_VERSION` bump — `usage` stays optional on `SessionState`, so
  an older reader ignoring the field is fine.
- `yarn lint`, `yarn check-types` and `yarn run compile` must all pass before
  any commit. Conventional-commit prefixes (`feat:`, `fix:`, `test:`,
  `chore:`, `docs:`). Commit after every task.

---

## Task 1: Shared `UsageTotals` type, `AgentEvent`'s `usage` kind, and arithmetic helpers

**Files:**
- Modify: `src/providers/types.ts:284-292` (the `usage` kind and its doc comment)
- Create: `src/shared/usage-totals.ts`
- Test: `src/test/unit/usage-totals.test.ts`

**Interfaces:**
- Produces: `UsageTotals` (exported from `src/providers/types.ts`), the
  widened `AgentEvent`'s `{ kind: 'usage'; normal: UsageTotals; subagent?: UsageTotals }`,
  and `addUsageTotals(a: UsageTotals | undefined, b: UsageTotals): UsageTotals`
  / `sumUsageTotals(list: UsageTotals[]): UsageTotals` from
  `src/shared/usage-totals.ts`. Every later task consumes these exact names.

- [ ] **Step 1: Write the failing test for the arithmetic helpers**

Create `src/test/unit/usage-totals.test.ts`:

```ts
import * as assert from 'assert';
import { addUsageTotals, sumUsageTotals } from '../../shared/usage-totals';
import type { UsageTotals } from '../../providers/types';

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, ...over,
});

suite('usage-totals', () => {
  test('addUsageTotals adds a delta onto an undefined running total', () => {
    const result = addUsageTotals(undefined, totals({ inputTokens: 10, outputTokens: 5 }));
    assert.deepStrictEqual(result, totals({ inputTokens: 10, outputTokens: 5 }));
  });

  test('addUsageTotals adds a delta onto an existing running total, field by field', () => {
    const running = totals({
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 2,
    });
    const delta = totals({
      inputTokens: 3, outputTokens: 1, cacheReadTokens: 50, cacheCreationTokens: 0,
    });
    assert.deepStrictEqual(
      addUsageTotals(running, delta),
      totals({ inputTokens: 13, outputTokens: 6, cacheReadTokens: 150, cacheCreationTokens: 2 }),
    );
  });

  test('sumUsageTotals sums every field across a list', () => {
    const list = [
      totals({ inputTokens: 10, outputTokens: 5 }),
      totals({ inputTokens: 3, cacheReadTokens: 20 }),
      totals({ cacheCreationTokens: 7 }),
    ];
    assert.deepStrictEqual(
      sumUsageTotals(list),
      totals({ inputTokens: 13, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 7 }),
    );
  });

  test('sumUsageTotals of an empty list is all zeros', () => {
    assert.deepStrictEqual(sumUsageTotals([]), totals());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep usage-totals`
Expected: FAIL — `Cannot find module '../../shared/usage-totals'`

- [ ] **Step 3: Add `UsageTotals` and widen `AgentEvent`'s `usage` kind**

In `src/providers/types.ts`, replace lines 284-292:

```ts
  | { kind: 'turn-end'; reason: 'done' | 'interrupted' | 'error'; error?: string }
  // Cache fields are Claude-only diagnostics: cacheReadTokens is billed ~0.1x,
  // cacheCreationTokens ~1.25x — the split is what tells a "why is usage
  // draining" investigation whether turns land warm or cold. Absent when the
  // backend does not report them.
  | {
    kind: 'usage'; inputTokens: number; outputTokens: number;
    cacheReadTokens?: number; cacheCreationTokens?: number;
  }
```

with:

```ts
  | { kind: 'turn-end'; reason: 'done' | 'interrupted' | 'error'; error?: string }
  /**
   * A running cumulative total, not a per-turn delta — each provider adapter
   * accumulates its own native signal (a per-turn delta for Claude and ACP,
   * an already-cumulative per-thread snapshot for Codex) before emitting
   * this, so the host only ever assigns the latest value, never sums.
   *
   * `subagent` is present only when the provider's data can actually
   * attribute spend to a spawned subagent — today, Codex only, because its
   * subagents are separate threads each reporting their own usage. Absent
   * means "this provider can't tell you," never a faked zero.
   *
   * Cache fields are billed differently per provider (cacheReadTokens
   * ~0.1x, cacheCreationTokens ~1.25x on Claude) — a provider with no
   * concept of a field (Codex has no cache-creation billing; ACP has
   * neither) reports it as a real 0, not an omission.
   */
  | { kind: 'usage'; normal: UsageTotals; subagent?: UsageTotals }
```

Add the `UsageTotals` interface above `AgentEvent` (right before the
`export type AgentEvent =` line, after `McpServerStatus`):

```ts
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

```

- [ ] **Step 4: Create the arithmetic helpers**

Create `src/shared/usage-totals.ts`:

```ts
import type { UsageTotals } from '../providers/types';

/**
 * Adds a delta onto a running total. `undefined` in means "no turns yet" —
 * the delta becomes the whole running total, not zero plus itself, so the
 * caller never has to special-case the first turn.
 */
export function addUsageTotals(running: UsageTotals | undefined, delta: UsageTotals): UsageTotals {
  return {
    inputTokens: (running?.inputTokens ?? 0) + delta.inputTokens,
    outputTokens: (running?.outputTokens ?? 0) + delta.outputTokens,
    cacheReadTokens: (running?.cacheReadTokens ?? 0) + delta.cacheReadTokens,
    cacheCreationTokens: (running?.cacheCreationTokens ?? 0) + delta.cacheCreationTokens,
  };
}

/** Sums a list of totals — e.g. several Codex subagent threads into one `subagent` bucket. */
export function sumUsageTotals(list: UsageTotals[]): UsageTotals {
  return list.reduce<UsageTotals>(
    (acc, next) => addUsageTotals(acc, next),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn test:unit --grep usage-totals`
Expected: PASS (4 tests)

- [ ] **Step 6: Type-check**

Run: `yarn check-types`
Expected: FAILs at this point — `map-events.ts` (Claude/Codex), `acp-run.ts`,
`agent-session.ts`, `session-manager.ts` and the fixture files still
construct the old `usage` shape. This is expected; Tasks 2-6 fix every
remaining call site. Confirm the errors are confined to those files (no
surprise breakage elsewhere), then continue.

- [ ] **Step 7: Commit**

```bash
git add src/providers/types.ts src/shared/usage-totals.ts src/test/unit/usage-totals.test.ts
git commit -m "feat: add UsageTotals type and cumulative-total arithmetic helpers"
```

---

## Task 2: Widen `SessionState.usage`, update the host handler and every default-construction site

**Files:**
- Modify: `src/protocol/messages.ts:198`
- Modify: `src/host/agent-session.ts:1117-1133`
- Modify: `src/host/session-manager.ts:644`, `:697`
- Modify: `src/test/fixtures/protocol.ts:36`
- Test: `src/test/unit/agent-session.test.ts`

**Interfaces:**
- Consumes: `UsageTotals` from Task 1.
- Produces: `SessionState.usage?: { normal: UsageTotals; subagent?: UsageTotals }`.
  Every later UI/provider task reads this exact shape off `pane.summary.usage`
  / `SessionState.usage`.

- [ ] **Step 1: Widen the protocol type**

In `src/protocol/messages.ts`, replace line 198:

```ts
  usage: { inputTokens: number; outputTokens: number };
```

with:

```ts
  /**
   * Cumulative for the whole session, not a per-turn snapshot. `undefined`
   * until the first `usage` event arrives — never defaulted to zeros at
   * session creation, matching the "nobody answered yet" reading everywhere
   * else in this codebase (`probing`, `contextPercent`).
   */
  usage?: { normal: UsageTotals; subagent?: UsageTotals };
```

Add `UsageTotals` to the existing `import type { ... } from '../providers/types'`
at the top of the file (or add a new `import type { UsageTotals } from '../providers/types';`
if `messages.ts` does not already import from `providers/types` — check the
top of the file first; protocol/messages.ts is allowed to import provider
*types* since the invariant only bars `vscode`, not the providers module).

- [ ] **Step 2: Write the failing test for the host handler**

In `src/test/unit/agent-session.test.ts`, find the existing usage-stale tests
(around line 1014, `test('a usage-stale event pulls the window set...')`) and
add, in the same suite:

```ts
test('a usage event replaces state.usage with the event\'s totals, not a sum', async () => {
  const { session, provider } = buildSession();
  session.send('hi');
  await flush();

  provider.runs[0].emit({
    kind: 'usage',
    normal: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  });
  await flush();
  assert.deepStrictEqual(session.state.usage, {
    normal: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  });

  provider.runs[0].emit({
    kind: 'usage',
    normal: { inputTokens: 25, outputTokens: 12, cacheReadTokens: 0, cacheCreationTokens: 0 },
  });
  await flush();
  assert.deepStrictEqual(
    session.state.usage?.normal,
    { inputTokens: 25, outputTokens: 12, cacheReadTokens: 0, cacheCreationTokens: 0 },
    'the host assigns the latest total verbatim — the adapter already accumulated it',
  );
});

test('a usage event with a subagent bucket carries it through to state', async () => {
  const { session, provider } = buildSession();
  session.send('hi');
  await flush();

  provider.runs[0].emit({
    kind: 'usage',
    normal: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    subagent: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0 },
  });
  await flush();

  assert.deepStrictEqual(
    session.state.usage?.subagent,
    { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0 },
  );
});
```

Use whatever this suite's existing `buildSession()`/setup helper and
`flush()`/`await new Promise(...)` pattern already is (see the neighboring
`usage-stale` tests in the same file for the exact helper names in use — copy
their setup, not a new one).

- [ ] **Step 3: Run test to verify it fails**

Run: `yarn test:unit --grep "a usage event"`
Expected: FAIL (type error or the old handler still writing
`{ inputTokens, outputTokens }` without `normal`)

- [ ] **Step 4: Rewrite the host handler**

In `src/host/agent-session.ts`, replace lines 1117-1133:

```ts
      case 'usage':
        // Per-turn cost trace for usage-drain investigations: the cache
        // read/creation split is the whole signal (see AgentEvent's usage
        // doc comment), so it goes to the debug log even though the state
        // snapshot keeps only the headline numbers.
        lifecycleDebug('session.turn-usage', {
          sessionId: this._state.id,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheCreationTokens: event.cacheCreationTokens,
        });
        this._state.usage = {
          inputTokens: event.inputTokens, outputTokens: event.outputTokens,
        };
        this.sink.changed();
        return;
```

with:

```ts
      case 'usage':
        // The adapter already accumulated this into a running total (see
        // AgentEvent's usage doc comment) — this is a plain assignment, not
        // a sum. `subagent` is only ever present when the provider's data
        // can back the split (Codex today).
        lifecycleDebug('session.turn-usage', {
          sessionId: this._state.id,
          normal: event.normal,
          ...(event.subagent ? { subagent: event.subagent } : {}),
        });
        this._state.usage = {
          normal: event.normal,
          ...(event.subagent ? { subagent: event.subagent } : {}),
        };
        this.sink.changed();
        return;
```

- [ ] **Step 5: Drop the zeroed default at session creation**

In `src/host/session-manager.ts`, remove the `usage:` line entirely from both
construction sites (the field is optional, so omitting it is `undefined` —
"no turns yet"):

At line 644 (inside `create()`'s `state` object):

```ts
      resumeTokens: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      archived: false, createdAt: now, updatedAt: now,
```

becomes:

```ts
      resumeTokens: {},
      archived: false, createdAt: now, updatedAt: now,
```

At line 697 (inside `fork()`'s `forkState` object), same edit:

```ts
      resumeTokens: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      archived: false, createdAt: now, updatedAt: now,
```

becomes:

```ts
      resumeTokens: {},
      archived: false, createdAt: now, updatedAt: now,
```

- [ ] **Step 6: Update the shared test fixture**

In `src/test/fixtures/protocol.ts`, remove line 36 from `summary()`'s default
object (same reasoning — optional field, undefined by default):

```ts
    resumeTokens: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false,
```

becomes:

```ts
    resumeTokens: {},
    archived: false,
```

- [ ] **Step 7: Fix every other call site the compiler flags**

Run `yarn check-types` and fix each remaining `usage: { inputTokens: 0, outputTokens: 0 }`
literal the compiler flags in test files not touched above (from the Task 1
grep: `src/test/unit/agent-session-relocation.test.ts:19`,
`agent-session-nesting.test.ts:17`, `agent-session-queue.test.ts:19`,
`session-manager.test.ts` (4 occurrences), `session-mentions.test.ts:10`,
`transcript-store.test.ts:92`, `webview-reducer.test.ts:37`,
`protocol.test.ts:274`). Every one of these either builds a `SessionState`/
`SessionSummary` object directly (delete the `usage:` line — it's optional)
or spreads `summary(...)`/a fixture that already stopped setting it in Step 6
(no change needed there). Do not touch test assertions that check `.usage`
value equality unless they specifically assert the old
`{inputTokens,outputTokens}` shape — grep for `.usage,` and `.usage)` after
the literal removals to confirm none remain.

- [ ] **Step 8: Run the full test suite and type-check**

Run: `yarn test:unit && yarn check-types`
Expected: `agent-session.test.ts`'s new tests PASS. `check-types` still fails
only in the provider adapter files (`map-events.ts` x2, `acp-run.ts`) — those
are fixed in Tasks 3-5.

- [ ] **Step 9: Commit**

```bash
git add src/protocol/messages.ts src/host/agent-session.ts src/host/session-manager.ts \
  src/test/fixtures/protocol.ts src/test/unit/agent-session.test.ts \
  src/test/unit/agent-session-relocation.test.ts src/test/unit/agent-session-nesting.test.ts \
  src/test/unit/agent-session-queue.test.ts src/test/unit/session-manager.test.ts \
  src/test/unit/session-mentions.test.ts src/test/unit/transcript-store.test.ts \
  src/test/unit/webview-reducer.test.ts src/test/unit/protocol.test.ts
git commit -m "feat: widen SessionState.usage to a cumulative normal/subagent shape"
```

---

## Task 3: Claude adapter — accumulate per-turn deltas into a running total

**Files:**
- Modify: `src/providers/claude/map-events.ts:291-309`
- Modify: `src/providers/claude/claude-provider.ts` (near line 503, and the
  `for (const event of mapEvent(msg))` loop at 663-693)
- Test: `src/test/unit/map-events.test.ts:125-156`
- Test: `src/test/unit/claude-provider.test.ts`

**Interfaces:**
- Consumes: `UsageTotals`, `addUsageTotals` from Tasks 1-2.
- Produces: `claudeUsageDelta(msg): UsageTotals | undefined`, exported from
  `map-events.ts` — a pure per-message reader, no accumulation. Accumulation
  lives in `claude-provider.ts`, which is the only place that emits the
  `usage` `AgentEvent` for this provider now.

- [ ] **Step 1: Rewrite the existing Claude usage tests around the new split**

In `src/test/unit/map-events.test.ts`, replace lines 125-156 (the three
`result` → usage tests) with tests against a new exported `claudeUsageDelta`,
and confirm `mapEvent` itself no longer produces a `usage` event:

```ts
  test('a successful result no longer carries a usage event through mapEvent — turn-end only', () => {
    const events = mapEvent({
      type: 'result', subtype: 'success',
      usage: { input_tokens: 10, output_tokens: 20 },
    } as never);
    assert.deepStrictEqual(events, [{ kind: 'turn-end', reason: 'done' }]);
  });

  test('claudeUsageDelta reads the four fields off a result message', () => {
    const delta = claudeUsageDelta({
      type: 'result', subtype: 'success',
      usage: {
        input_tokens: 10, output_tokens: 20,
        cache_read_input_tokens: 30_000, cache_creation_input_tokens: 4_000,
      },
    } as never);
    assert.deepStrictEqual(delta, {
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 30_000, cacheCreationTokens: 4_000,
    });
  });

  test('claudeUsageDelta defaults missing cache fields to 0, not undefined', () => {
    const delta = claudeUsageDelta({
      type: 'result', subtype: 'success',
      usage: { input_tokens: 10, output_tokens: 20 },
    } as never);
    assert.deepStrictEqual(delta, {
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0,
    });
  });

  test('claudeUsageDelta is undefined for a message with no usage block', () => {
    assert.strictEqual(
      claudeUsageDelta({ type: 'result', subtype: 'error_during_execution' } as never),
      undefined,
    );
  });
```

Add `claudeUsageDelta` to the file's existing `import { mapEvent } from '../../providers/claude/map-events';`
line (becomes `import { claudeUsageDelta, mapEvent } from '../../providers/claude/map-events';`).

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "claudeUsageDelta"`
Expected: FAIL — `claudeUsageDelta is not a function` (not yet exported)

- [ ] **Step 3: Move usage-reading out of `mapEvent` into `claudeUsageDelta`**

In `src/providers/claude/map-events.ts`, replace lines 291-309:

```ts
  if (type === 'result') {
    const out: AgentEvent[] = [];
    const usage = (msg as {
      usage?: {
        input_tokens?: number; output_tokens?: number;
        cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
      };
    }).usage;
    if (usage) {
      out.push({
        kind: 'usage',
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        ...(usage.cache_read_input_tokens !== undefined
          ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
        ...(usage.cache_creation_input_tokens !== undefined
          ? { cacheCreationTokens: usage.cache_creation_input_tokens } : {}),
      });
    }
    const subtype = (msg as { subtype?: string }).subtype;
```

with:

```ts
  if (type === 'result') {
    const out: AgentEvent[] = [];
    const subtype = (msg as { subtype?: string }).subtype;
```

Then, near the top of the file (after the imports, alongside the other
exported helpers — check where `mapEvent` itself is declared and place this
just above it, matching the file's existing top-to-bottom order of small
helpers before the big switch), add:

```ts
/**
 * Reads one message's own usage, if it reports any — a per-turn delta, NOT a
 * running total (the SDK's `result.usage` is scoped to that turn alone).
 * `claude-provider.ts` is what accumulates these into `state.usage`; this
 * function stays a pure reader so it can be tested without a live query.
 * Missing cache fields become a real `0` (the field existed on the message,
 * it was simply zero this turn) rather than a signal the backend doesn't
 * report them at all — unlike the old per-event `cacheReadTokens?` which
 * conflated "zero this turn" with "never reports this."
 */
export function claudeUsageDelta(msg: unknown): UsageTotals | undefined {
  const usage = (msg as {
    type?: string;
    usage?: {
      input_tokens?: number; output_tokens?: number;
      cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
    };
  }).usage;
  if (!usage) { return undefined; }
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}
```

Add `UsageTotals` to this file's `import type { ... } from '../types';` line.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "usage\|claudeUsageDelta"`
Expected: PASS

- [ ] **Step 5: Write the failing multi-turn accumulation test in `claude-provider.test.ts`**

Add, in the existing `suite('ClaudeProvider', ...)` (or whichever suite wraps
the file — match what's already there), modeled on the existing
`interrupt() stops every tracked background task...` test's `queryFn`/`gen`
scaffolding at lines 1132-1182:

```ts
  test('accumulates usage across turns into a running normal total, never a subagent field', async () => {
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
    let turn = 0;
    const queryFn = (params: { prompt: AsyncIterable<unknown>; options: unknown }) => {
      void params;
      const gen = (async function* () {
        turn += 1;
        if (turn === 1) {
          yield {
            type: 'result', subtype: 'success',
            usage: { input_tokens: 10, output_tokens: 5 },
            uuid: 'u1', session_id: 's1',
          };
        } else {
          yield {
            type: 'result', subtype: 'success',
            usage: {
              input_tokens: 3, output_tokens: 2,
              cache_read_input_tokens: 100, cache_creation_input_tokens: 4,
            },
            uuid: 'u2', session_id: 's1',
          };
        }
        await stopSignal;
      })() as AsyncGenerator<unknown, void> & {
        interrupt: () => Promise<undefined>;
        setPermissionMode: () => Promise<void>;
        applyFlagSettings: () => Promise<void>;
        close: () => void;
        mcpServerStatus: () => Promise<unknown[]>;
      };
      gen.interrupt = async () => undefined;
      gen.setPermissionMode = async () => { /* no-op fake */ };
      gen.applyFlagSettings = async () => { /* no-op fake */ };
      gen.close = () => { stop(); };
      gen.mcpServerStatus = async () => [];
      return gen;
    };

    const provider = new ClaudeProvider((async () => queryFn) as never);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default', sessionId: 'test-session' });
    const events = collect(run);
    run.send('one');
    await tick();
    run.send('two');
    await tick();

    const usageEvents = events().filter((e) => e.kind === 'usage');
    assert.strictEqual(usageEvents.length, 2);
    assert.deepStrictEqual(usageEvents[0], {
      kind: 'usage',
      normal: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    assert.deepStrictEqual(usageEvents[1], {
      kind: 'usage',
      normal: { inputTokens: 13, outputTokens: 7, cacheReadTokens: 100, cacheCreationTokens: 4 },
    });
    assert.strictEqual(
      usageEvents.every((e) => e.kind === 'usage' && e.subagent === undefined),
      true,
      'Claude never reports a subagent split',
    );
    await run.dispose();
  });
```

- [ ] **Step 6: Run test to verify it fails**

Run: `yarn test:unit --grep "accumulates usage across turns"`
Expected: FAIL — the pushed event still has the old
`{inputTokens, outputTokens, cacheReadTokens?, cacheCreationTokens?}` shape,
not `{normal: ...}` (type error at compile, or assertion mismatch once
Task 1/2's types compile).

- [ ] **Step 7: Accumulate in `claude-provider.ts`**

Add a running-total local near the other per-run locals (alongside
`backgroundTaskIds` at line 503):

```ts
    let usageTotal: UsageTotals | undefined;
```

Add `UsageTotals` and `addUsageTotals` imports at the top of the file
(`import type { UsageTotals } from './types';` if not already importing from
`'../types'` — match the file's existing relative import style; add
`import { addUsageTotals } from '../../shared/usage-totals';`).

In the `for await (const msg of session)` loop, right after
`for (const event of mapEvent(msg)) {` opens (before the existing
`background-tasks-changed` check at line 664), read the message's own delta
once per message (not per mapped event) and push the accumulated total.
Insert this immediately before the `for (const event of mapEvent(msg))` line
(i.e. operating on `msg` directly, once per SDK message):

```ts
            const usageDelta = claudeUsageDelta(msg);
            if (usageDelta) {
              usageTotal = addUsageTotals(usageTotal, usageDelta);
              events.push({ kind: 'usage', normal: usageTotal });
            }
            for (const event of mapEvent(msg)) {
```

Add `claudeUsageDelta` to this file's existing `import { mapEvent } from './map-events';`
(or equivalent) line.

- [ ] **Step 8: Run test to verify it passes**

Run: `yarn test:unit --grep "accumulates usage across turns"`
Expected: PASS

- [ ] **Step 9: Full check**

Run: `yarn test:unit && yarn check-types`
Expected: PASS except Codex/ACP files (Tasks 4-5 still pending)

- [ ] **Step 10: Commit**

```bash
git add src/providers/claude/map-events.ts src/providers/claude/claude-provider.ts \
  src/test/unit/map-events.test.ts src/test/unit/claude-provider.test.ts
git commit -m "feat: accumulate Claude per-turn usage into a running cumulative total"
```

---

## Task 4: Codex adapter — cumulative per-thread totals, subagent split forwarded instead of dropped

**Files:**
- Modify: `src/providers/codex/map-events.ts:71-80`
- Modify: `src/providers/codex/codex-run.ts` (fields near line 189-211,
  `captureContextUsage` near 399-417, notification handler 232-282)
- Test: `src/test/unit/codex-map-events.test.ts:278-285`
- Test: `src/test/unit/codex-run.test.ts`

**Interfaces:**
- Consumes: `UsageTotals`, `sumUsageTotals` from Task 1; `TokenUsageBreakdown`,
  `ThreadTokenUsage` already imported in `codex-run.ts` from `./wire`.
- Produces: `CodexRun` pushes `{ kind: 'usage', normal, subagent? }` events;
  `mapNotification` no longer produces a `usage` kind for
  `thread/tokenUsage/updated` at all (that method is handled explicitly in
  `CodexRun` now, both for the run's own thread and for rejoined subagent
  threads).

- [ ] **Step 1: Rewrite the existing `mapNotification` usage test**

In `src/test/unit/codex-map-events.test.ts`, replace lines 278-285:

```ts
  test('token usage becomes an input/output usage event', () => {
    assert.deepStrictEqual(
      mapNotification('thread/tokenUsage/updated', {
        tokenUsage: { total: { inputTokens: 100, outputTokens: 20 }, modelContextWindow: 200_000 },
      }),
      [{ kind: 'usage', inputTokens: 100, outputTokens: 20 }],
    );
  });
```

with:

```ts
  test('token usage is no longer mapped generically — CodexRun handles it explicitly to tag own vs child threads', () => {
    assert.deepStrictEqual(
      mapNotification('thread/tokenUsage/updated', {
        tokenUsage: { total: { inputTokens: 100, outputTokens: 20 }, modelContextWindow: 200_000 },
      }),
      [],
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "token usage"`
Expected: FAIL — old code still returns a `usage` event

- [ ] **Step 3: Remove the `usage` case from `mapNotification`**

In `src/providers/codex/map-events.ts`, delete lines 71-80:

```ts
    case 'thread/tokenUsage/updated': {
      const total = (p as { tokenUsage?: { total?: { inputTokens?: number; outputTokens?: number } } })
        .tokenUsage?.total;
      if (!total) { return []; }
      return [{
        kind: 'usage',
        inputTokens: total.inputTokens ?? 0,
        outputTokens: total.outputTokens ?? 0,
      }];
    }
```

(Falls through to the `default: return [];` case, matching the new test.)

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "token usage"`
Expected: PASS

- [ ] **Step 5: Write the failing `CodexRun` tests for own-thread and subagent-thread usage**

Add to `src/test/unit/codex-run.test.ts`, after the existing subagent suite
(after the test ending around line 692), reusing this file's own `stub()`,
`started()` and `collect()` helpers (defined at the top of the file, read
above):

```ts
  test('own-thread token usage becomes a normal-only usage event', async () => {
    const { server, send } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);

    send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'th_1',
        tokenUsage: {
          total: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 0 },
          last: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 0 },
          modelContextWindow: 200_000,
        },
      },
    });
    await tick();

    const usage = events().find((e) => e.kind === 'usage');
    assert.deepStrictEqual(usage, {
      kind: 'usage',
      normal: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 5, cacheCreationTokens: 0 },
    });
  });

  test('a rejoined subagent thread\'s usage is tagged as the subagent bucket, not dropped', async () => {
    const { server, send } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);

    send({
      method: 'item/started',
      params: {
        threadId: 'th_1',
        item: {
          type: 'subAgentActivity', id: 'sa_1', kind: 'started',
          agentThreadId: 'th_child', agentPath: 'reviewer',
        },
      },
    });
    await tick();
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'th_1',
        tokenUsage: {
          total: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
          last: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
          modelContextWindow: 200_000,
        },
      },
    });
    await tick();
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'th_child',
        tokenUsage: {
          total: { totalTokens: 15, inputTokens: 12, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0 },
          last: { totalTokens: 15, inputTokens: 12, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0 },
          modelContextWindow: 200_000,
        },
      },
    });
    await tick();

    const usage = events().filter((e) => e.kind === 'usage').at(-1);
    assert.deepStrictEqual(usage, {
      kind: 'usage',
      normal: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
      subagent: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
  });

  test('a closed subagent thread\'s last-known usage still counts toward the subagent bucket', async () => {
    const { server, send } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);

    send({
      method: 'item/started',
      params: {
        threadId: 'th_1',
        item: {
          type: 'subAgentActivity', id: 'sa_1', kind: 'started',
          agentThreadId: 'th_child', agentPath: 'reviewer',
        },
      },
    });
    await tick();
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'th_child',
        tokenUsage: {
          total: { totalTokens: 15, inputTokens: 12, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0 },
          last: { totalTokens: 15, inputTokens: 12, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0 },
          modelContextWindow: 200_000,
        },
      },
    });
    await tick();
    send({
      method: 'item/completed',
      params: {
        threadId: 'th_1',
        item: {
          type: 'subAgentActivity', id: 'sa_1', kind: 'interrupted',
          agentThreadId: 'th_child', agentPath: 'reviewer',
        },
      },
    });
    await tick();
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'th_1',
        tokenUsage: {
          total: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
          last: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
          modelContextWindow: 200_000,
        },
      },
    });
    await tick();

    const usage = events().filter((e) => e.kind === 'usage').at(-1);
    assert.deepStrictEqual(usage?.kind === 'usage' ? usage.subagent : undefined,
      { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
      'the child thread left, but its last-known usage still counts — see leaveSubagentThread');
  });
```

Check the exact `item/completed` shape a `subAgentActivity` interrupted event
uses against the existing "a subagent going interrupted unsubscribes its own
thread" test in the same file (around line 694) before finalizing this
step's fixture — mirror its params exactly rather than guessing the field
names.

- [ ] **Step 6: Run test to verify it fails**

Run: `yarn test:unit --grep "usage"`
Expected: FAIL — `CodexRun` does not yet capture or emit usage totals at all

- [ ] **Step 7: Add usage-tracking state and helpers to `CodexRun`**

In `src/providers/codex/codex-run.ts`, add two fields near `childThreads`
(after its declaration around line 189):

```ts
  /** This run's own thread — latest cumulative total, replace not add (Codex already sums it). */
  private ownUsageTotal: UsageTotals | undefined;

  /**
   * Every rejoined subagent thread's latest cumulative total, keyed by its
   * `agentThreadId`. Deliberately NOT cleared in `leaveSubagentThread` — a
   * closed subagent's last-known spend still happened and still counts
   * toward this run's subagent total.
   */
  private readonly childUsageTotals = new Map<string, UsageTotals>();
```

Add `UsageTotals` to the existing `import type { ... } from '../types';` (or
add an import from `'../types'` if not present), and
`import { sumUsageTotals } from '../../shared/usage-totals';`.

Add three private methods near `captureContextUsage` (after it, around line 417):

```ts
  private toUsageTotals(b: TokenUsageBreakdown): UsageTotals {
    // Codex has no cache-creation concept (automatic, unbilled) — a real 0,
    // not "unmeasured". cachedInputTokens is the read-side equivalent.
    return {
      inputTokens: b.inputTokens, outputTokens: b.outputTokens,
      cacheReadTokens: b.cachedInputTokens, cacheCreationTokens: 0,
    };
  }

  /** This run's own thread reported usage — replaces (already cumulative), then re-emits. */
  private captureOwnUsage(usage: ThreadTokenUsage | undefined): void {
    if (!usage) { return; }
    this.ownUsageTotal = this.toUsageTotals(usage.total);
    this.emitUsage();
  }

  /** A rejoined subagent thread reported usage — replaces that thread's entry, then re-emits. */
  private captureChildUsage(agentThreadId: string, usage: ThreadTokenUsage | undefined): void {
    if (!usage) { return; }
    this.childUsageTotals.set(agentThreadId, this.toUsageTotals(usage.total));
    this.emitUsage();
  }

  /**
   * Combines the own-thread total with every known subagent thread's total
   * (summed) and pushes one `usage` event. No-op until the own thread has
   * reported at least once — a `subagent` total with no `normal` yet would
   * be a claim about a turn that has not started.
   */
  private emitUsage(): void {
    if (!this.ownUsageTotal) { return; }
    const subagentTotals = [...this.childUsageTotals.values()];
    this.events.push({
      kind: 'usage',
      normal: this.ownUsageTotal,
      ...(subagentTotals.length > 0 ? { subagent: sumUsageTotals(subagentTotals) } : {}),
    });
  }
```

- [ ] **Step 8: Wire the notification handler**

In the constructor's `server.onNotification` callback, first the own-thread
branch (around line 259-261):

```ts
      if (method === 'thread/tokenUsage/updated') {
        this.captureContextUsage((params as { tokenUsage?: ThreadTokenUsage } | undefined)?.tokenUsage);
      }
```

becomes:

```ts
      if (method === 'thread/tokenUsage/updated') {
        const tokenUsage = (params as { tokenUsage?: ThreadTokenUsage } | undefined)?.tokenUsage;
        this.captureContextUsage(tokenUsage);
        this.captureOwnUsage(tokenUsage);
      }
```

Then the `fromChild` branch (around lines 245-256):

```ts
      if (fromChild !== undefined) {
        // A subagent's own thread — only its tool lifecycle nests under the
        // spawn card; its `turn/completed`, usage, and text deltas are that
        // thread's business, not this run's turn. `mapNotification` still
        // does the item -> `ToolCall` translation; only `parentId` and the
        // event-kind filter are specific to a child's traffic.
        for (const event of mapNotification(method, params)) {
          if (event.kind === 'tool-start' || event.kind === 'tool-end') {
            this.events.push({ ...event, parentId: fromChild });
          }
        }
        return;
      }
```

becomes:

```ts
      if (fromChild !== undefined) {
        // A subagent's own thread — only its tool lifecycle nests under the
        // spawn card; its `turn/completed` and text deltas are that thread's
        // business, not this run's turn. Its token usage is the one
        // exception: captured (not nested) so it can be tagged into this
        // run's `subagent` bucket — see `captureChildUsage`.
        if (method === 'thread/tokenUsage/updated') {
          this.captureChildUsage(named as string, (params as { tokenUsage?: ThreadTokenUsage } | undefined)?.tokenUsage);
        }
        for (const event of mapNotification(method, params)) {
          if (event.kind === 'tool-start' || event.kind === 'tool-end') {
            this.events.push({ ...event, parentId: fromChild });
          }
        }
        return;
      }
```

(`named` is already in scope — it's the variable `threadIdOf(method, params)`
assigned earlier in this same callback, per the code read during planning.)

- [ ] **Step 9: Run test to verify it passes**

Run: `yarn test:unit --grep "usage"`
Expected: PASS (all three new `CodexRun` tests, plus the rewritten
`map-events.ts` one)

- [ ] **Step 10: Full check**

Run: `yarn test:unit && yarn check-types`
Expected: PASS except `acp-run.ts` (Task 5 still pending)

- [ ] **Step 11: Commit**

```bash
git add src/providers/codex/map-events.ts src/providers/codex/codex-run.ts \
  src/test/unit/codex-map-events.test.ts src/test/unit/codex-run.test.ts
git commit -m "feat: forward Codex subagent thread usage instead of dropping it"
```

---

## Task 5: ACP/OpenCode adapter — accumulate per-turn deltas, no cache fields, no subagent split

**Files:**
- Modify: `src/providers/acp/acp-run.ts:35`, `:614-622`
- Test: `src/test/unit/acp-run.test.ts`

**Interfaces:**
- Consumes: `UsageTotals`, `addUsageTotals` from Task 1.
- Produces: `AcpRun` pushes `{ kind: 'usage', normal: UsageTotals }` (never
  `subagent`) after every `prompt()` reply that carries a `usage` block.

- [ ] **Step 1: Write the failing accumulation test**

Add to `src/test/unit/acp-run.test.ts`, in the `suite('AcpRun', ...)` block,
modeled on the existing `'interrupt cancels a parked permission request'`
test's `handshake`/`send`/`waitFor` pattern (read above, around line 450):

```ts
  test('accumulates usage across turns into a running normal total, never a subagent field', async () => {
    const p = peer();
    const events: AgentEvent[] = [];
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code', sessionId: 'test-session', });
    collect(run, events);
    await handshake(p);

    run.send('one');
    const first = await p.waitFor('session/prompt');
    p.emit({ jsonrpc: '2.0', id: first.id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } } });
    await new Promise((r) => setTimeout(r, 20));

    run.send('two');
    const second = await p.waitFor('session/prompt');
    p.emit({ jsonrpc: '2.0', id: second.id, result: { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2 } } });
    await new Promise((r) => setTimeout(r, 20));

    const usageEvents = events.filter((e) => e.kind === 'usage');
    assert.strictEqual(usageEvents.length, 2);
    assert.deepStrictEqual(usageEvents[0], {
      kind: 'usage',
      normal: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    assert.deepStrictEqual(usageEvents[1], {
      kind: 'usage',
      normal: { inputTokens: 13, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    assert.strictEqual(
      usageEvents.every((e) => e.kind === 'usage' && e.subagent === undefined),
      true,
      'ACP never reports a subagent split',
    );
    await run.dispose();
  });
```

`waitFor('session/prompt')` will need to be called a second time after the
first reply — confirm against this file's existing multi-turn tests (e.g.
the `interrupt()` test around line 524, `run.send('build it')` after an
earlier turn) that `p.waitFor` correctly finds the *next* `session/prompt`
frame rather than re-returning the first one; if `waitFor` only ever returns
the first match, add a `p.sent.length` high-water mark the same way that
test does, rather than assuming.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "accumulates usage across turns"`
Expected: FAIL — the pushed event still has the old
`{inputTokens, outputTokens}` shape (no `normal` wrapper, no cache fields)

- [ ] **Step 3: Widen `PromptUsage` handling and accumulate**

In `src/providers/acp/acp-run.ts`, add a class field near the top of the
`AcpRun` class (wherever its other per-run private fields are declared —
check the class body for the right spot, matching the existing field
ordering/doc-comment style):

```ts
  /** Running cumulative total across every turn this run has sent. Never a subagent field — ACP's prompt reply has no per-thread concept to hang one off. */
  private usageTotal: UsageTotals | undefined;
```

Add imports: `import type { UsageTotals } from '../types';` (add `UsageTotals`
to the existing `import type { ... } from '../types';` block at the top of
the file) and `import { addUsageTotals } from '../../shared/usage-totals';`.

Replace lines 617-622:

```ts
      const usage = reply?.usage;
      if (usage) {
        this.events.push({
          kind: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        });
      }
```

with:

```ts
      const usage = reply?.usage;
      if (usage) {
        // No cache fields on the wire (PromptUsage has none) — a real 0,
        // not "unmeasured". Never a subagent field: ACP's prompt reply has
        // no per-thread concept to attribute one to.
        this.usageTotal = addUsageTotals(this.usageTotal, {
          inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
          cacheReadTokens: 0, cacheCreationTokens: 0,
        });
        this.events.push({ kind: 'usage', normal: this.usageTotal });
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "accumulates usage across turns"`
Expected: PASS

- [ ] **Step 5: Full check**

Run: `yarn test:unit && yarn check-types`
Expected: PASS — every provider adapter now compiles against the widened
`AgentEvent`/`SessionState` types.

- [ ] **Step 6: Commit**

```bash
git add src/providers/acp/acp-run.ts src/test/unit/acp-run.test.ts
git commit -m "feat: accumulate ACP per-turn usage into a running cumulative total"
```

---

## Task 6: UI — "Token usage" section in the context dialog

**Files:**
- Modify: `src/webview/components/context-dialog.tsx`
- Test: `src/test/dom/context-ring.test.tsx`

**Interfaces:**
- Consumes: `pane.summary.usage` (`SessionState['usage']` from Task 2),
  the existing `formatTokens` helper already in this file (line 33-40).
- Produces: no new exports — a section rendered inside `ContextDialog`'s
  `DialogContent`, below the existing `Body`.

- [ ] **Step 1: Write the failing DOM tests**

In `src/test/dom/context-ring.test.tsx`, add a `mount` override for `usage`
(the existing `mount(contextPercent?)` helper at lines 22-33 only sets
`contextPercent`) — add a second optional param:

```ts
function mount(contextPercent?: number, usage?: SessionSummary['usage']): void {
  renderWithStore(<RingUnderTest />);
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a', { contextPercent, usage })],
    layout: layoutOf(['a']),
    snapshots: [snapshot('a', { contextPercent, usage })],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}
```

Add `import type { SessionSummary } from '../../protocol/messages';` to this
test file's imports (check it isn't already imported before adding a
duplicate).

Add new tests at the end of the `suite('ContextRing', ...)` block:

```ts
  test('shows no usage yet when the session has not reported any', async () => {
    mount(43);
    await open('Context 43% used');

    assert.ok(screen.getByText('No usage yet'));
  });

  test('renders the four normal usage rows once the session has usage', async () => {
    mount(43, {
      normal: { inputTokens: 1234, outputTokens: 567, cacheReadTokens: 8900, cacheCreationTokens: 12 },
    });
    await open('Context 43% used');

    assert.ok(screen.getByText('Token usage'));
    assert.ok(screen.getByText('1234'));
    assert.ok(screen.getByText('567'));
    assert.ok(screen.getByText('8.9k'));
    assert.ok(screen.getByText('12'));
  });

  test('a subagent bucket renders as a secondary sub-block', async () => {
    mount(43, {
      normal: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
      subagent: { inputTokens: 400, outputTokens: 90, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    await open('Context 43% used');

    assert.ok(screen.getByText('Subagents'));
    assert.ok(screen.getByText('400'));
    assert.ok(screen.getByText('90'));
  });

  test('no subagent bucket means no Subagents sub-block at all', async () => {
    mount(43, {
      normal: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    await open('Context 43% used');

    assert.strictEqual(screen.queryByText('Subagents') === null, true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom --grep "usage"`
Expected: FAIL — no "Token usage" section exists yet

- [ ] **Step 3: Add the section to `context-dialog.tsx`**

Add a small formatting-consistent component below `MemoryRow` (after line
152, before `Body`):

```tsx
function UsageRow({ label, tokens }: { label: string; tokens: number }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 tabular-nums">{formatTokens(tokens)}</span>
    </div>
  );
}

function UsageSection({ usage }: { usage: SessionState['usage'] }) {
  if (!usage) {
    return <p className="py-0.5 text-muted-foreground">No usage yet</p>;
  }
  return (
    <div className="space-y-2">
      <div>
        <UsageRow label="Input" tokens={usage.normal.inputTokens} />
        <UsageRow label="Output" tokens={usage.normal.outputTokens} />
        <UsageRow label="Cache read" tokens={usage.normal.cacheReadTokens} />
        <UsageRow label="Cache write" tokens={usage.normal.cacheCreationTokens} />
      </div>
      {usage.subagent && (
        <div className="border-t border-border pt-1.5">
          {/* Secondary, not a fourth peer row group: this is a provider-specific
              breakdown of the normal total above, not an independent figure. */}
          <p className="pb-0.5 text-muted-foreground">Subagents</p>
          <UsageRow label="Input" tokens={usage.subagent.inputTokens} />
          <UsageRow label="Output" tokens={usage.subagent.outputTokens} />
          <UsageRow label="Cache read" tokens={usage.subagent.cacheReadTokens} />
          <UsageRow label="Cache write" tokens={usage.subagent.cacheCreationTokens} />
        </div>
      )}
    </div>
  );
}
```

Add `import type { ContextResult, SessionState } from '../../protocol/messages';`
(widen the existing `import type { ContextResult } from '../../protocol/messages';`
at line 9 to also bring in `SessionState`).

Wire it into `ContextDialog`'s render, right after `<Body .../>` inside
`DialogContent` (around line 293, before the closing `</DialogContent>`):

```tsx
        <Body
          result={result}
          onOpenFile={(path) => post({ t: 'open-file', id, path })}
          onRetry={() => post({ t: 'request-context', id })}
        />
        <div className="space-y-1 border-t border-border pt-2">
          <p className="text-muted-foreground">Token usage</p>
          <UsageSection usage={pane.summary.usage} />
        </div>
```

`pane` is already a prop of `ContextDialog` (destructured at line 248), so
`pane.summary.usage` is in scope without a new prop or a new pulled request —
this data arrives with every `sessions-changed`/`session-patch` the panel
already pushes.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:dom --grep "usage"`
Expected: PASS (4 new tests)

- [ ] **Step 5: Run the impeccable detector over the changed file**

Per this project's CLAUDE.md ("UI changes go through impeccable"), run:

```bash
node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/context-dialog.tsx
```

(Resolve `<impeccable-skill-dir>` the same way the skill's own instructions
do — check `.claude`/plugin skill paths for `impeccable` before running.)
Exit 0 is clean; exit 2 means findings to fix inline before continuing.

- [ ] **Step 6: Full check**

Run: `yarn test:unit && yarn test:dom && yarn check-types && yarn lint && yarn run compile`
Expected: PASS across the board — this is the final task, so this is the
whole feature's green gate.

- [ ] **Step 7: Commit**

```bash
git add src/webview/components/context-dialog.tsx src/test/dom/context-ring.test.tsx
git commit -m "feat: show cumulative token usage, normal vs subagent, in the context dialog"
```

---

## Self-review notes

- **Spec coverage:** data model (Task 1-2), Claude/Codex/ACP emission
  semantics (Tasks 3-5), persistence (free — confirmed no code needed beyond
  the type widening in Task 2, since `StoredIndex.sessions` already
  serializes `SessionState` whole), UI (Task 6), testing (a unit test in
  every provider-adapter task plus the host and DOM layers) — every spec
  section has a task.
- **Placeholder scan:** no TBDs; every step shows real code or a concrete
  command.
- **Type consistency:** `UsageTotals` (Task 1) flows unchanged through
  `AgentEvent`'s `usage` kind (Task 1), `SessionState.usage` (Task 2), every
  provider adapter's emitted event (Tasks 3-5), and `pane.summary.usage` in
  the UI (Task 6) — same field names (`inputTokens`, `outputTokens`,
  `cacheReadTokens`, `cacheCreationTokens`) and the same `normal`/`subagent`
  wrapper everywhere.
