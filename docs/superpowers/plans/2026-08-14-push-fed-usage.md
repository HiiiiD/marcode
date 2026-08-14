# Push-Fed Account Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the panel's account-usage strip a render of windows the provider *pushed*, so it shows real numbers immediately after a window reload instead of an error, and delete the request/reply machinery that made it pull-shaped.

**Architecture:** The Claude Agent SDK emits `SDKRateLimitEvent` on its normal message stream whenever a rate-limit window moves. `map-events.ts` maps it to a new `usage-window` `AgentEvent`; `AgentSession` hands the window up its sink; `SessionManager` keeps the latest window per `(providerId, windowId)`, persists that map beside `index.json`, and broadcasts it ungated. The webview strip becomes a pure render with no effects and no timers. Everything that existed only to support the pull — `AgentRun.usageWindows`, `SessionManager.usageWindows`, `request-usage`, the experimental SDK call, the client throttle — is deleted. The per-session context ring and its popover stay pull-based and are untouched except for two correctness fixes carried in this branch.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk@0.3.228`, React 19, Tailwind v4, esbuild, mocha (`suite`/`test` globals) for unit and jsdom DOM tests.

**Spec:** [docs/superpowers/specs/2026-08-13-usage-and-context-design.md](../specs/2026-08-13-usage-and-context-design.md) — amended 2026-08-14 for exactly this change. Read its amendment banner and its Flow, Protocol, UI and Testing sections before Task 1.

**Handoff this plan discharges:** [docs/superpowers/handoffs/2026-08-14-usage-push-handoff.md](../handoffs/2026-08-14-usage-push-handoff.md) (Part 1 and Part 2; Part 3 was settled with the user — the integration test is deliberately not automated, recorded in the spec, and the maintainer verifies the surfaces by hand in a dev host).

## Global Constraints

- **Work inside the worktree.** Every command in this plan runs from `E:/Efebia/hiiiid-code/.claude/worktrees/push-fed-usage` on branch `worktree-push-fed-usage`. A subagent's shell may start in a *different* checkout of this repo: prefix commands with `cd E:/Efebia/hiiiid-code/.claude/worktrees/push-fed-usage &&` and confirm `git log -1 --oneline` shows your own commit before reporting a task done. A previous plan's first task committed into the wrong repository this way.
- **`src/protocol/messages.ts` is types-only.** No runtime code, no `vscode` import.
- **Nothing under `src/providers/` or `src/protocol/` imports `vscode`.** Neither does `src/host/message-router.ts`.
- **Every protocol message addressed to a session carries an explicit `SessionId`.** `usage-windows` is *not* session-addressed — it carries a `providerId`, which is deliberate and allowed: account usage is not session state.
- **Errors are state, never exceptions.** Nothing rejects across `postMessage`.
- **Transcript patches fan out only to visible sessions.** `sessions-changed`, `session-status` and (new) `usage-windows` are ungated.
- **Filenames are kebab-case.** Component identifiers stay PascalCase.
- **Usage and context surfaces show percentages, never token counts.** Tokens exist only inside `src/providers/claude/map-context.ts`.
- **shadcn only in webview feature code.** No bare `<button>`/`<span>`-as-control; compose classNames with `cn` from `@/lib/utils`, never template literals.
- **Gates before every commit:** `yarn lint`, `yarn check-types`, `yarn run compile`, `yarn test:unit`, `yarn test:dom` all pass. Baseline at the start of this branch is **363 unit, 152 DOM**.
- **Any task touching `src/webview/components/` also runs the impeccable detector** over the files it changed: `node <impeccable-skill-dir>/scripts/detect.mjs --json <files>`. Exit 0 is required; exit 2 is a failing check.
- **Conventional commits:** `feat:`, `fix:`, `test:`, `chore:`, `docs:`.

---

## File Structure

| Path | Change | Responsibility after the change |
|---|---|---|
| `src/providers/types.ts` | Modify | `AgentEvent` gains `usage-window`; `AgentRun.usageWindows` is deleted |
| `src/providers/claude/map-context.ts` | Modify | Gains `toUsageWindow` (one event → one window); loses `toUsageWindows`, `UsageLike`, `RateWindowLike`, `makeWindow`, the ISO `resetsAt` parser; memory rows re-based (Task 5) |
| `src/providers/claude/map-events.ts` | Modify | Maps `rate_limit_event` |
| `src/providers/claude/claude-provider.ts` | Modify | Loses the `usageWindows` run method and the experimental-call feature detection |
| `src/providers/fake/fake-provider.ts` | Modify | Scripted windows are emitted as `usage-window` events at `start()`, not answered from a method |
| `src/shared/usage-windows.ts` | Create | The fixed display order of window ids, shared by host and provider so neither owns the other's table |
| `src/host/agent-session.ts` | Modify | Handles `usage-window` → `sink.usageWindow`; loses `usageWindows()`; `contextBreakdown()` refreshes `contextPercent` (Task 4) |
| `src/host/session-manager.ts` | Modify | Owns the `(providerId, windowId)` map, ordering, reset pruning, ungated emit, persistence; loses `usageWindows()` |
| `src/host/transcript-store.ts` | Modify | Gains `readUsage()` / `writeUsage()` over a `usage.json` sibling of `index.json` |
| `src/host/message-router.ts` | Modify | Loses the `request-usage` case; `hydrate` carries the usage map |
| `src/protocol/messages.ts` | Modify | `usage-windows` becomes a push; `request-usage` and `UsageResult` are deleted; `hydrate` gains `usage` |
| `src/webview/reducer.ts` | Modify | `usageByProvider: Record<string, UsageWindow[] \| undefined>`; seeded by `hydrate`, replaced by `usage-windows` |
| `src/webview/components/usage-strip.tsx` | Modify | Pure render — no effects, no refs, no timers; one honest quiet state |
| `src/webview/components/context-ring.tsx` | Modify | One percentage source for ring, danger and popover header (Task 4) |
| `src/extension.ts` | Modify | Dev-host `FakeProvider` scripting keeps its two windows through the new seam |
| `src/test/dom/usage-strip.test.tsx` | Modify | Drives the strip with pushed `usage-windows` and `hydrate`; the false rationale comment goes |
| `src/test/unit/*` | Modify | `map-events`, `map-context`, `claude-provider`, `fake-provider`, `agent-session`, `session-manager`, `message-router`, `reducer`, `transcript-store` |

---

### Task 1: The provider seam — usage arrives as an event

Purely additive. The pull path still exists and still works when this task ends; nothing else in the tree changes behaviour yet.

**Files:**
- Modify: `src/providers/types.ts` (the `AgentEvent` union, ~line 119)
- Modify: `src/providers/claude/map-context.ts` (add `toUsageWindow`; leave `toUsageWindows` in place for now)
- Modify: `src/providers/claude/map-events.ts` (`mapEvent`, ~line 161)
- Modify: `src/providers/fake/fake-provider.ts` (~line 129)
- Create: `src/shared/usage-windows.ts`
- Test: `src/test/unit/map-context.test.ts`, `src/test/unit/map-events.test.ts`, `src/test/unit/fake-provider.test.ts`

**Interfaces:**
- Produces:
  - `type AgentEvent = … | { kind: 'usage-window'; window: UsageWindow }`
  - `export interface RateLimitInfoLike { rateLimitType?: string; utilization?: number; resetsAt?: number }` (in `map-context.ts`)
  - `export function toUsageWindow(info: RateLimitInfoLike | undefined): UsageWindow | undefined` (in `map-context.ts`)
  - `export const USAGE_WINDOW_ORDER: readonly string[]` and `export function orderWindows(windows: UsageWindow[]): UsageWindow[]` (in `src/shared/usage-windows.ts`)
- Consumes: `UsageWindow` from `src/providers/types.ts` (unchanged shape: `{ id, label, usedPercent, resetsAt? }`)

**Background the implementer needs.** The SDK type, verified in this worktree at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:4408`:

```ts
export declare type SDKRateLimitEvent = {
    type: 'rate_limit_event';
    rate_limit_info: SDKRateLimitInfo;
    uuid: UUID;
    session_id: string;
};
export declare type SDKRateLimitInfo = {
    status: 'allowed' | 'allowed_warning' | 'rejected';
    resetsAt?: number;          // epoch ms — NOT an ISO string
    rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet'
                  | 'seven_day_overage_included' | 'overage';
    utilization?: number;       // 0..100
    // …overage fields we do not read
};
```

One event describes **one** window, not a set. `map-events.ts` never imports SDK types (see its header comment for why); it reads `unknown` structurally. `map-context.ts` already declares its SDK shapes structurally for the same reason — follow that.

Two deliberate losses, both fine: the `overage` and `seven_day_overage_included` types get no label and are dropped, and the old `model_scoped[]` per-model windows have no equivalent on this event, so they disappear. Neither is in the spec's goals.

- [ ] **Step 1: Write the failing tests for `toUsageWindow`**

Append to `src/test/unit/map-context.test.ts` (the file already imports from `../../providers/claude/map-context`; extend that import):

```ts
suite('toUsageWindow', () => {
  test('maps a five-hour event to the table id and label', () => {
    assert.deepStrictEqual(
      toUsageWindow({ rateLimitType: 'five_hour', utilization: 62, resetsAt: 1_700_000_000_000 }),
      { id: 'five-hour', label: 'Session (5h)', usedPercent: 62, resetsAt: 1_700_000_000_000 },
    );
  });

  test('rounds and clamps utilization into 0..100', () => {
    assert.strictEqual(toUsageWindow({ rateLimitType: 'seven_day', utilization: 18.4 })?.usedPercent, 18);
    assert.strictEqual(toUsageWindow({ rateLimitType: 'seven_day', utilization: 140 })?.usedPercent, 100);
    assert.strictEqual(toUsageWindow({ rateLimitType: 'seven_day', utilization: -3 })?.usedPercent, 0);
  });

  test('omits resetsAt rather than carrying a non-finite one', () => {
    const w = toUsageWindow({ rateLimitType: 'seven_day_opus', utilization: 5, resetsAt: Number.NaN });
    assert.deepStrictEqual(w, { id: 'seven-day-opus', label: 'Week (Opus)', usedPercent: 5 });
  });

  test('drops an event with no utilization — there is no percentage to show', () => {
    assert.strictEqual(toUsageWindow({ rateLimitType: 'five_hour' }), undefined);
  });

  test('drops an event with no rateLimitType, and the overage types, rather than guessing a label', () => {
    assert.strictEqual(toUsageWindow({ utilization: 40 }), undefined);
    assert.strictEqual(toUsageWindow({ rateLimitType: 'overage', utilization: 40 }), undefined);
    assert.strictEqual(
      toUsageWindow({ rateLimitType: 'seven_day_overage_included', utilization: 40 }), undefined,
    );
    assert.strictEqual(toUsageWindow(undefined), undefined);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd E:/Efebia/hiiiid-code/.claude/worktrees/push-fed-usage && yarn test:unit`
Expected: FAIL — `toUsageWindow is not exported` / TypeScript error on the import.

- [ ] **Step 3: Implement `toUsageWindow`**

In `src/providers/claude/map-context.ts`, keep `WINDOW_LABELS` exactly where it is (its `key` values are already the `rateLimitType` spellings) and add below it:

```ts
/**
 * The subset of `SDKRateLimitInfo` (sdk.d.ts:4421) this mapper reads,
 * declared structurally for the same reason `ContextUsageLike` is. Note
 * `resetsAt` is epoch ms here — the experimental usage response this module
 * used to read carried an ISO string instead, which is why nothing parses.
 */
export interface RateLimitInfoLike {
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
}

/**
 * One `rate_limit_event` describes one window. An event we cannot label
 * (`overage`, `seven_day_overage_included`, or a type a future SDK adds) or
 * cannot quantify (no `utilization`) produces nothing: a chip with a guessed
 * label or an invented percentage is worse than a chip that is not there.
 */
export function toUsageWindow(info: RateLimitInfoLike | undefined): UsageWindow | undefined {
  if (!info) { return undefined; }
  const row = WINDOW_LABELS.find((w) => w.key === info.rateLimitType);
  if (!row) { return undefined; }
  if (typeof info.utilization !== 'number' || !Number.isFinite(info.utilization)) { return undefined; }
  const at = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)
    ? info.resetsAt
    : undefined;
  return {
    id: row.id,
    label: row.label,
    usedPercent: Math.max(0, Math.min(100, Math.round(info.utilization))),
    ...(at !== undefined ? { resetsAt: at } : {}),
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `yarn test:unit`
Expected: PASS, unit count up by 5.

- [ ] **Step 5: Add the `usage-window` event to the union**

In `src/providers/types.ts`, in the `AgentEvent` union after the `usage` member:

```ts
  /**
   * One account/plan usage window moved. Pushed, not polled: the SDK emits
   * `rate_limit_event` whenever rate-limit info changes, so the host holds
   * the last value per window rather than asking a live query for it. One
   * event carries one window — never the whole set.
   */
  | { kind: 'usage-window'; window: UsageWindow }
```

- [ ] **Step 6: Write the failing test for the event mapping**

Append to `src/test/unit/map-events.test.ts`:

```ts
suite('rate_limit_event', () => {
  test('maps to a single usage-window event', () => {
    assert.deepStrictEqual(
      mapEvent({
        type: 'rate_limit_event',
        session_id: 's1',
        rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 62 },
      }),
      [{ kind: 'usage-window', window: { id: 'five-hour', label: 'Session (5h)', usedPercent: 62 } }],
    );
  });

  test('an unlabelable or unquantifiable event maps to nothing', () => {
    assert.deepStrictEqual(
      mapEvent({ type: 'rate_limit_event', session_id: 's1', rate_limit_info: { status: 'allowed' } }),
      [],
    );
    assert.deepStrictEqual(mapEvent({ type: 'rate_limit_event', session_id: 's1' }), []);
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `yarn test:unit`
Expected: FAIL — `mapEvent` returns `[]` for the first case (there is no branch for this type yet).

- [ ] **Step 8: Map it**

In `src/providers/claude/map-events.ts`, extend the import line to
`import { toUsageWindow, type RateLimitInfoLike } from './map-context';`
and add this branch in `mapEvent`, immediately before the final `return []`:

```ts
  if (type === 'rate_limit_event') {
    // Pushed by the CLI whenever plan usage moves — including once shortly
    // after connect, which is what lets the strip show real numbers without
    // anyone having sent a message.
    const window = toUsageWindow(
      (msg as { rate_limit_info?: RateLimitInfoLike }).rate_limit_info,
    );
    return window ? [{ kind: 'usage-window', window }] : [];
  }
```

Then extend this file's header comment: the `SDKMessage` variant list already
explains which variants are mapped, so add a bullet in the same voice recording
that `rate_limit_event` is mapped, that `rate_limit_info.resetsAt` is epoch ms
(not an ISO string like the experimental usage response), and that one event is
one window.

- [ ] **Step 9: Run it and watch it pass**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 10: Create the shared display order**

Create `src/shared/usage-windows.ts`:

```ts
import type { UsageWindow } from '../providers/types';

/**
 * The order the strip renders windows in, shortest window first. Fixed, and
 * never derived from utilization: a strip that reorders itself as the numbers
 * move cannot be read at a glance.
 *
 * It lives in `shared/` because two modules need it and neither should own
 * the other's table — the Claude mapper assigns these ids (see
 * `WINDOW_LABELS` in providers/claude/map-context.ts), and SessionManager,
 * which must not import a provider's internals, sorts by them.
 */
export const USAGE_WINDOW_ORDER: readonly string[] = [
  'five-hour', 'seven-day', 'seven-day-opus', 'seven-day-sonnet',
];

/**
 * Known ids first in table order, then anything else by id. A provider that
 * reports a window this table has never heard of still renders — at the end,
 * deterministically — rather than vanishing.
 */
export function orderWindows(windows: UsageWindow[]): UsageWindow[] {
  const rank = (id: string) => {
    const i = USAGE_WINDOW_ORDER.indexOf(id);
    return i === -1 ? USAGE_WINDOW_ORDER.length : i;
  };
  return [...windows].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}
```

- [ ] **Step 11: Write the failing test for the order**

Create `src/test/unit/usage-windows.test.ts`:

```ts
import * as assert from 'assert';
import { orderWindows } from '../../shared/usage-windows';
import type { UsageWindow } from '../../providers/types';

function w(id: string): UsageWindow {
  return { id, label: id, usedPercent: 0 };
}

suite('orderWindows', () => {
  test('puts known ids in table order regardless of arrival order', () => {
    assert.deepStrictEqual(
      orderWindows([w('seven-day-opus'), w('five-hour'), w('seven-day')]).map((x) => x.id),
      ['five-hour', 'seven-day', 'seven-day-opus'],
    );
  });

  test('keeps an unknown id, last and deterministically', () => {
    assert.deepStrictEqual(
      orderWindows([w('zeta'), w('alpha'), w('five-hour')]).map((x) => x.id),
      ['five-hour', 'alpha', 'zeta'],
    );
  });

  test('does not mutate its input', () => {
    const input = [w('seven-day'), w('five-hour')];
    orderWindows(input);
    assert.deepStrictEqual(input.map((x) => x.id), ['seven-day', 'five-hour']);
  });
});
```

- [ ] **Step 12: Run it and watch it pass** (the implementation from Step 10 is already there — this is a written-after check, so if any case fails, the implementation is wrong, not the test)

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 13: Make `FakeProvider` push its scripted windows**

In `src/providers/fake/fake-provider.ts`, replace the scripted-windows line at the end of `start()`:

```ts
    const { context, windows } = this.reports;
    if (context) { run.contextBreakdown = async () => context; }
    if (windows) { run.usageWindows = async () => windows; }
```

with:

```ts
    const { context, windows } = this.reports;
    if (context) { run.contextBreakdown = async () => context; }
    // Pushed at start, before any send — which is exactly the case the real
    // provider has to serve after a window reload, and the case the pull
    // shape could not.
    for (const window of windows ?? []) { channel.push({ kind: 'usage-window', window }); }
```

Keep `FakeReports.windows` typed as `UsageWindow[]` — only the delivery changes.

- [ ] **Step 14: Update the fake-provider test**

In `src/test/unit/fake-provider.test.ts`, the two tests around lines 108 and 119 assert on `run.usageWindows`. Replace them with:

```ts
  test('scripted windows arrive as usage-window events before any send', async () => {
    const provider = new FakeProvider(undefined, {
      windows: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62 }],
    });
    const run = provider.start({ cwd: '/w', permissionMode: 'default' });
    const it = run.events[Symbol.asyncIterator]();
    assert.deepStrictEqual((await it.next()).value, {
      kind: 'usage-window',
      window: { id: 'five-hour', label: 'Session (5h)', usedPercent: 62 },
    });
    await run.dispose();
  });

  test('an unscripted fake emits no usage-window events', async () => {
    const provider = new FakeProvider();
    const run = provider.start({ cwd: '/w', permissionMode: 'default' });
    const events: AgentEvent[] = [];
    void (async () => { for await (const e of run.events) { events.push(e); } })();
    await run.dispose();
    assert.ok(!events.some((e) => e.kind === 'usage-window'));
  });
```

Match the file's existing construction style for `FakeProvider` and its `AgentEvent` import; if the suite already has a helper for draining events, use it rather than adding a second idiom.

- [ ] **Step 15: Run the gates**

Run: `yarn lint && yarn check-types && yarn test:unit && yarn test:dom`
Expected: all pass. The pull path is still in place and still green — `ClaudeProvider.usageWindows` and `SessionManager.usageWindows` are untouched by this task.

- [ ] **Step 16: Commit**

```bash
git add src/providers src/shared/usage-windows.ts src/test/unit
git commit -m "feat: map the SDK's rate_limit_event to a usage-window event

SDKRateLimitEvent is a first-class SDKMessage variant carrying utilization
and resetsAt, so account usage can be pushed instead of pulled from an
experimental method on a live query. Adds the event, the one-event-one-window
mapper, the shared display order, and makes FakeProvider script windows as
events. The pull path still stands; it comes out next."
```

---

### Task 2: The host holds the set, the wire flips, the pull is deleted

The atomic task. `usage-windows` changes shape on the wire, so host, protocol and webview move together — splitting them would leave `yarn check-types` red at a commit boundary, which the project's gates forbid.

**Files:**
- Modify: `src/host/agent-session.ts` (`SessionSink` ~line 16, `handle()` ~line 348, delete `usageWindows()` ~line 262)
- Modify: `src/host/session-manager.ts` (delete `usageWindows()` ~lines 198-222, add the map and the sink method)
- Modify: `src/host/message-router.ts` (delete the `request-usage` case ~line 171 and its entry in the wire-message allowlist ~line 210)
- Modify: `src/protocol/messages.ts` (~lines 106-108, 134, 165)
- Modify: `src/providers/types.ts` (delete `AgentRun.usageWindows`, ~lines 160-166)
- Modify: `src/providers/claude/claude-provider.ts` (delete the `usageWindows` run method, ~lines 514-527, and the now-unused `toUsageWindows` / `UsageLike` / `UsageWindow` imports at ~lines 127-131)
- Modify: `src/providers/claude/map-context.ts` (delete `toUsageWindows`, `UsageLike`, `RateWindowLike`, `makeWindow`, the ISO `resetsAt` parser)
- Modify: `src/webview/reducer.ts` (~lines 30-32, 126-130)
- Modify: `src/webview/components/usage-strip.tsx` (delete the whole effect apparatus, rewrite the states)
- Test: `src/test/unit/agent-session.test.ts`, `src/test/unit/session-manager.test.ts`, `src/test/unit/message-router.test.ts`, `src/test/unit/claude-provider.test.ts`, `src/test/unit/map-context.test.ts`, `src/test/unit/reducer.test.ts`, `src/test/dom/usage-strip.test.tsx`

**Interfaces:**
- Consumes: `{ kind: 'usage-window'; window: UsageWindow }` and `orderWindows` from Task 1.
- Produces:
  - `SessionSink.usageWindow(providerId: string, window: UsageWindow): void`
  - `SessionManager.usageSnapshot(): Record<string, UsageWindow[]>` — every provider's current ordered, unexpired set. Task 3 persists it and puts it on `hydrate`.
  - Wire: `{ t: 'usage-windows'; providerId: string; windows: UsageWindow[] }`
  - Reducer state: `usageByProvider: Record<string, UsageWindow[] | undefined>`

- [ ] **Step 1: Write the failing host tests**

In `src/test/unit/session-manager.test.ts`, following the file's existing setup idiom (a `TranscriptStore` over a temp dir, a `FakeProvider`, and an `emit` spy collecting `HostToWebview`):

```ts
  test('a pushed window is broadcast ungated, ordered, and keyed by provider', async () => {
    // The session is deliberately NOT made visible: account usage is not a
    // per-pane concern, so this must go out anyway.
    const session = await manager.create('fake', '/w');
    const run = provider.runs.at(-1)!;
    run.emit({ kind: 'usage-window', window: { id: 'seven-day', label: 'Week', usedPercent: 18 } });
    run.emit({ kind: 'usage-window', window: { id: 'five-hour', label: 'Session (5h)', usedPercent: 62 } });
    await settle();

    const last = emitted().filter((m) => m.t === 'usage-windows').at(-1);
    assert.deepStrictEqual(last, {
      t: 'usage-windows',
      providerId: 'fake',
      windows: [
        { id: 'five-hour', label: 'Session (5h)', usedPercent: 62 },
        { id: 'seven-day', label: 'Week', usedPercent: 18 },
      ],
    });
    void session;
  });

  test('a second event for the same window replaces rather than appends', async () => {
    await manager.create('fake', '/w');
    const run = provider.runs.at(-1)!;
    run.emit({ kind: 'usage-window', window: { id: 'five-hour', label: 'Session (5h)', usedPercent: 62 } });
    run.emit({ kind: 'usage-window', window: { id: 'five-hour', label: 'Session (5h)', usedPercent: 71 } });
    await settle();

    const last = emitted().filter((m) => m.t === 'usage-windows').at(-1);
    assert.deepStrictEqual(last!.windows, [
      { id: 'five-hour', label: 'Session (5h)', usedPercent: 71 },
    ]);
  });

  test('an unchanged window emits nothing — the strip must not churn', async () => {
    await manager.create('fake', '/w');
    const run = provider.runs.at(-1)!;
    const window = { id: 'five-hour', label: 'Session (5h)', usedPercent: 62 };
    run.emit({ kind: 'usage-window', window });
    await settle();
    const before = emitted().filter((m) => m.t === 'usage-windows').length;

    run.emit({ kind: 'usage-window', window: { ...window } });
    await settle();
    assert.strictEqual(emitted().filter((m) => m.t === 'usage-windows').length, before);
  });

  test('a window past its reset is dropped rather than shown stale', async () => {
    await manager.create('fake', '/w');
    const run = provider.runs.at(-1)!;
    run.emit({
      kind: 'usage-window',
      window: { id: 'five-hour', label: 'Session (5h)', usedPercent: 62, resetsAt: Date.now() - 1 },
    });
    await settle();

    assert.deepStrictEqual(manager.usageSnapshot(), { fake: [] });
  });

  test('two sessions of one provider feed the same account map', async () => {
    await manager.create('fake', '/w');
    const first = provider.runs.at(-1)!;
    await manager.create('fake', '/w');
    const second = provider.runs.at(-1)!;
    first.emit({ kind: 'usage-window', window: { id: 'five-hour', label: 'Session (5h)', usedPercent: 62 } });
    second.emit({ kind: 'usage-window', window: { id: 'seven-day', label: 'Week', usedPercent: 18 } });
    await settle();

    assert.deepStrictEqual(
      manager.usageSnapshot().fake.map((w) => w.id), ['five-hour', 'seven-day'],
    );
  });
```

`settle()` is whatever this suite already uses to let the event pump run (a `await new Promise((r) => setImmediate(r))` helper or similar); reuse it rather than introducing a second waiting idiom. `emitted()` is the existing emit spy.

- [ ] **Step 2: Run them and watch them fail**

Run: `yarn test:unit`
Expected: FAIL — `manager.usageSnapshot is not a function`, and no `usage-windows` message is emitted.

- [ ] **Step 3: Add the sink method and the session's handler**

In `src/host/agent-session.ts`, add to `SessionSink`:

```ts
  /**
   * A running session reported an account usage window. Keyed by provider,
   * not by session: plan limits belong to the account, and every session of
   * that provider reports the same numbers. Goes UP to the manager, which
   * owns the map, exactly like `invocables`.
   */
  usageWindow(providerId: string, window: UsageWindow): void;
```

and in `handle()`, beside the `usage` case:

```ts
      case 'usage-window':
        this.sink.usageWindow(this._state.providerId, event.window);
        return;
```

Delete `AgentSession.usageWindows()` (~line 262) and drop `UsageWindow` from the type import if nothing else in the file uses it — the `SessionSink` signature above does, so it stays.

- [ ] **Step 4: Add the map to `SessionManager`**

In `src/host/session-manager.ts`, add the field, the sink method and the snapshot accessor, and delete `usageWindows()` (~lines 198-222) with its `UsageResult` import:

```ts
  /**
   * providerId -> windowId -> the last window that provider reported.
   *
   * Account state, not session state: it is keyed by provider, it outlives
   * every session, and it deliberately does not live on `SessionState` —
   * a restored session must not carry a percentage that has since moved.
   */
  private usage = new Map<string, Map<string, UsageWindow>>();

  /**
   * Every provider's current window set, ordered for display and with
   * already-reset windows dropped. The pruning happens on read rather than
   * on a timer: nothing re-renders between reads anyway, and a timer would
   * be a second clock to keep correct.
   */
  usageSnapshot(): Record<string, UsageWindow[]> {
    const out: Record<string, UsageWindow[]> = {};
    for (const providerId of this.usage.keys()) {
      out[providerId] = this.windowsFor(providerId);
    }
    return out;
  }

  private windowsFor(providerId: string): UsageWindow[] {
    const known = this.usage.get(providerId);
    if (!known) { return []; }
    const now = Date.now();
    // A window whose reset has passed is known to be wrong, and the next
    // event may be hours away — so it is dropped, not shown at its last
    // percentage. This is the one case where "last known" is not the truth.
    return orderWindows(
      [...known.values()].filter((w) => w.resetsAt === undefined || w.resetsAt > now),
    );
  }
```

and in the `// --- SessionSink ---` block:

```ts
  usageWindow(providerId: string, window: UsageWindow): void {
    const known = this.usage.get(providerId) ?? new Map<string, UsageWindow>();
    const prev = known.get(window.id);
    // Identical repeats are ordinary: the CLI re-announces rate-limit info
    // on reconnect, and re-broadcasting an unchanged set would re-render the
    // strip for nothing.
    if (prev && prev.usedPercent === window.usedPercent && prev.resetsAt === window.resetsAt) {
      return;
    }
    known.set(window.id, window);
    this.usage.set(providerId, known);
    this.emit({ t: 'usage-windows', providerId, windows: this.windowsFor(providerId) });
    this.schedulePersist();
  }
```

Import `orderWindows` from `../shared/usage-windows` and `UsageWindow` from `../providers/types`.

- [ ] **Step 5: Flip the wire types**

In `src/protocol/messages.ts`: delete `UsageResult` (~lines 106-108) and the `request-usage` member of `WebviewToHost` (~line 134), and replace the `usage-windows` member of `HostToWebview` (~line 165) with:

```ts
  /**
   * Broadcast, not session-addressed, and not a reply: account usage belongs
   * to the provider's account, and it is pushed whenever the provider reports
   * a change. The array is the complete current set for that provider — a
   * snapshot, never a delta — so the client replaces rather than merges.
   * There is no not-ok arm: under a push there is no request that can fail,
   * and "nothing has been reported" is a state, not an error.
   */
  | { t: 'usage-windows'; providerId: string; windows: UsageWindow[] };
```

In `src/host/message-router.ts`, delete the `request-usage` case (~lines 171-174) and remove `'request-usage'` from the allowlist at ~line 210.

- [ ] **Step 6: Delete the provider-side pull**

In `src/providers/types.ts`, delete `AgentRun.usageWindows` and its doc comment. In `src/providers/claude/claude-provider.ts`, delete the whole `usageWindows:` run method and prune the now-unused `UsageWindow`, `toUsageWindows` and `UsageLike` imports. In `src/providers/claude/map-context.ts`, delete `UsageLike`, `RateWindowLike`, `makeWindow`, the ISO-parsing `resetsAt` helper and `toUsageWindows` — `WINDOW_LABELS` and `toUsageWindow` stay.

- [ ] **Step 7: Prune the tests that asserted the pull**

- `src/test/unit/agent-session.test.ts:585` — `usageWindows rejects when unsupported`: delete; the method is gone. Add in its place a test that a `usage-window` event reaches the sink with the session's provider id, using the suite's existing fake sink.
- `src/test/unit/claude-provider.test.ts:319, 329` — the first asserts both `contextBreakdown()` and `usageWindows()` reject before the first `send()`; narrow it to `contextBreakdown()` only. Delete the second outright.
- `src/test/unit/map-context.test.ts:147, 169` — the `toUsageWindows` cases: delete. The `toUsageWindow` cases from Task 1 replace them.
- `src/test/unit/message-router.test.ts` — any `request-usage` case: delete.

- [ ] **Step 8: Run the host gates**

Run: `yarn test:unit`
Expected: the Step 1 tests PASS. The webview will still fail `yarn check-types` — that is expected until Step 12.

- [ ] **Step 9: Write the failing reducer and DOM tests**

In `src/test/unit/reducer.test.ts`:

```ts
  test('usage-windows replaces a provider entry wholesale', () => {
    let state = reduce(initialState, {
      t: 'usage-windows', providerId: 'fake',
      windows: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62 }],
    });
    state = reduce(state, {
      t: 'usage-windows', providerId: 'fake',
      windows: [{ id: 'seven-day', label: 'Week', usedPercent: 18 }],
    });
    assert.deepStrictEqual(state.usageByProvider.fake, [
      { id: 'seven-day', label: 'Week', usedPercent: 18 },
    ]);
  });

  test('an empty set is stored, not ignored — it is how a set clears', () => {
    let state = reduce(initialState, {
      t: 'usage-windows', providerId: 'fake',
      windows: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62 }],
    });
    state = reduce(state, { t: 'usage-windows', providerId: 'fake', windows: [] });
    assert.deepStrictEqual(state.usageByProvider.fake, []);
  });
```

Rewrite `src/test/dom/usage-strip.test.tsx` around the push. Delete the whole "restored sessions are not live until set-visible" comment at lines 26-36 and every assertion about `request-usage` — the strip posts nothing now. Keep the file's existing `sendFromHost` harness idiom and the existing rendering assertions (one chip per window, order preserved, chips keyboard-focusable, reset time in the tooltip), re-driven like this:

```ts
  test('renders the windows the host pushed', async () => {
    const { sendFromHost, container } = await mountStrip();
    sendFromHost({
      t: 'usage-windows', providerId: 'fake',
      windows: [
        { id: 'five-hour', label: 'Session (5h)', usedPercent: 62 },
        { id: 'seven-day', label: 'Week', usedPercent: 18 },
      ],
    });
    const chips = [...container.querySelectorAll('[role="img"]')];
    assert.deepStrictEqual(
      chips.map((c) => c.getAttribute('aria-label')),
      ['Session (5h) 62% used', 'Week 18% used'],
    );
  });

  test('the strip posts nothing — it is a render, not a request', async () => {
    const { sendFromHost, posted } = await mountStrip();
    sendFromHost({ t: 'usage-windows', providerId: 'fake', windows: [] });
    assert.ok(!posted().some((m) => m.t.startsWith('request-')));
  });

  test('a provider with nothing reported reads as not-reported, not as an error or as "no limits"', async () => {
    const { container } = await mountStrip();
    assert.match(container.textContent ?? '', /Plan usage not reported/);
  });
```

`mountStrip()` is whatever this file already uses to mount under the real `StoreProvider` (it must keep driving state through genuine `HostToWebview` messages — never a hand-built `ClientState`). If the existing helper seeds a roster via `hydrate`, keep that: the strip only lists providers that have sessions.

- [ ] **Step 10: Run them and watch them fail**

Run: `yarn test:unit && yarn test:dom`
Expected: FAIL — the reducer still stores a `UsageResult`, and the strip still renders `No plan limits`.

- [ ] **Step 11: Update the reducer**

In `src/webview/reducer.ts`, change the field and its comment:

```ts
  /**
   * The window set each provider has reported. Pushed by the host, replaced
   * wholesale. `undefined` means the host has said nothing about that
   * provider yet; an empty array means it said "nothing to show". They render
   * identically — the distinction exists only so this reducer never has to
   * invent a value.
   */
  usageByProvider: Record<string, UsageWindow[] | undefined>;
```

and the case:

```ts
    case 'usage-windows':
      return {
        ...state,
        usageByProvider: { ...state.usageByProvider, [msg.providerId]: msg.windows },
      };
```

Swap the `UsageResult` import for `UsageWindow`. Leave `hydrate`'s `usageByProvider: {}` alone — Task 3 seeds it.

- [ ] **Step 12: Rewrite the strip as a pure render**

`src/webview/components/usage-strip.tsx` loses `useEffect`, `useRef`, `REFRESH_MS`, `lastRequestedRef`, `pendingRef`, `retriedRef`, the unmount sweep, the retry-on-roster-change effect and the false rationale comment at ~line 124 in full. `WindowChip` and `resetsIn` are unchanged. `ProviderUsage` and `UsageStrip` become:

```tsx
function ProviderUsage({
  displayName, windows, showName,
}: { displayName: string; windows: UsageWindow[] | undefined; showName: boolean }) {
  // One quiet state covers two situations the push cannot tell apart: an
  // account that has not reported yet, and a session that never will (an API
  // key, Bedrock or Vertex, where plan limits do not exist). Asserting either
  // one would be a claim we cannot support, so the copy says only what is
  // true of both.
  if (!windows || windows.length === 0) {
    return <span className="text-muted-foreground">Plan usage not reported</span>;
  }

  return (
    <span className="flex shrink-0 items-center gap-3">
      {showName && <span className="text-muted-foreground">{displayName}</span>}
      {windows.map((w) => <WindowChip key={w.id} window={w} />)}
    </span>
  );
}

export function UsageStrip() {
  const { state } = useStore();
  // Providers that actually have sessions — the catalog can list one the
  // user has never opened, and the strip is about this panel's accounts.
  const providerIds = [...new Set(state.sessions.map((s) => s.providerId))];

  return (
    <div className="flex h-6 shrink-0 items-center gap-4 overflow-x-auto overflow-y-hidden border-t border-border px-2 text-xs">
      {providerIds.map((id) => (
        <ProviderUsage
          key={id}
          displayName={state.catalog.find((p) => p.id === id)?.displayName ?? id}
          windows={state.usageByProvider[id]}
          showName={providerIds.length > 1}
        />
      ))}
    </div>
  );
}
```

`post` is no longer destructured from `useStore()`; drop it. Import `UsageWindow` in place of `UsageResult`.

- [ ] **Step 13: Run every gate**

Run: `yarn lint && yarn check-types && yarn run compile && yarn test:unit && yarn test:dom`
Expected: all pass.

- [ ] **Step 14: Run the impeccable detector on the changed component**

Run: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/usage-strip.tsx`
Expected: exit 0. Exit 2 is a failing check — fix the findings before committing.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "feat: push account usage to the strip instead of pulling it

SessionManager now holds the last window each provider reported, keyed by
(providerId, windowId), orders it for display, drops windows past their reset
and broadcasts the set ungated. The strip renders it with no effects, no refs
and no timers.

Deletes the pull entirely: request-usage, AgentRun.usageWindows,
AgentSession.usageWindows, SessionManager.usageWindows, the experimental SDK
call and toUsageWindows. That path could not answer before a session's first
send, which is why the strip read as an error after every reload.

The old 'No plan limits' and failure states go with it. Under a push there is
no request to fail, and nothing distinguishes an account that has not reported
yet from one that never will, so one honest line covers both."
```

---

### Task 3: Persist the set beside `index.json` and seed `hydrate`

Without this, a reload still starts blank until the CLI re-announces. With it, the panel paints real numbers before anything runs — which is the whole point of the branch.

**Files:**
- Modify: `src/host/transcript-store.ts` (beside `readIndex`/`writeIndex`, ~lines 268-289)
- Modify: `src/host/session-manager.ts` (`init()` ~line 65, `persist()` ~line 427)
- Modify: `src/host/message-router.ts` (the `ready` case's `hydrate` emit, ~lines 72-78)
- Modify: `src/protocol/messages.ts` (the `hydrate` member, ~lines 158-159)
- Modify: `src/webview/reducer.ts` (the `hydrate` case, ~line 82)
- Test: `src/test/unit/transcript-store.test.ts`, `src/test/unit/session-manager.test.ts`, `src/test/unit/message-router.test.ts`, `src/test/unit/reducer.test.ts`

**Interfaces:**
- Consumes: `SessionManager.usageSnapshot()` from Task 2.
- Produces:
  - `export interface StoredUsage { providers: Record<string, UsageWindow[]> }` (in `transcript-store.ts`)
  - `TranscriptStore.readUsage(): Promise<StoredUsage>` / `writeUsage(usage: StoredUsage): Promise<void>`
  - `hydrate` gains `usage: Record<string, UsageWindow[]>`

- [ ] **Step 1: Write the failing store test**

In `src/test/unit/transcript-store.test.ts`, following the file's temp-dir idiom:

```ts
  test('usage round-trips through its own file', async () => {
    const store = new TranscriptStore(dir);
    await store.writeUsage({
      providers: { claude: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62 }] },
    });
    assert.deepStrictEqual(await new TranscriptStore(dir).readUsage(), {
      providers: { claude: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62 }] },
    });
  });

  test('a missing or unreadable usage file is an empty set, not a throw', async () => {
    assert.deepStrictEqual(await new TranscriptStore(dir).readUsage(), { providers: {} });
    await fs.writeFile(path.join(dir, 'usage.json'), '{ not json', 'utf8');
    assert.deepStrictEqual(await new TranscriptStore(dir).readUsage(), { providers: {} });
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `yarn test:unit`
Expected: FAIL — `store.writeUsage is not a function`.

- [ ] **Step 3: Implement the sibling file**

In `src/host/transcript-store.ts`, beside `readIndex`/`writeIndex`:

```ts
export interface StoredUsage {
  /** providerId -> that provider's last known window set. */
  providers: Record<string, UsageWindow[]>;
}
```

```ts
  /**
   * Its own file rather than a field on `index.json`: this is account data,
   * it is keyed by provider rather than by session, and it is rewritten on a
   * different cadence from the roster. A corrupt or absent file is an empty
   * set — usage is decoration over a working panel, and refusing to start
   * because a percentage could not be read would be absurd.
   */
  async readUsage(): Promise<StoredUsage> {
    try {
      const raw = await fs.readFile(path.join(this.rootDir, 'usage.json'), 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredUsage>;
      return { providers: parsed.providers ?? {} };
    } catch {
      return { providers: {} };
    }
  }

  async writeUsage(usage: StoredUsage): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(
      path.join(this.rootDir, 'usage.json'),
      JSON.stringify(usage, null, 2),
      'utf8',
    );
  }
```

Import `UsageWindow` from `../providers/types`.

- [ ] **Step 4: Write the failing manager test**

In `src/test/unit/session-manager.test.ts`:

```ts
  test('the window set survives a reload, minus anything already reset', async () => {
    await manager.create('fake', '/w');
    const run = provider.runs.at(-1)!;
    run.emit({
      kind: 'usage-window',
      window: { id: 'five-hour', label: 'Session (5h)', usedPercent: 62, resetsAt: Date.now() + 3_600_000 },
    });
    run.emit({
      kind: 'usage-window',
      window: { id: 'seven-day', label: 'Week', usedPercent: 18, resetsAt: Date.now() - 1 },
    });
    await settle();
    await manager.dispose();

    const revived = new SessionManager(new TranscriptStore(dir), providers, () => {});
    await revived.init();
    assert.deepStrictEqual(revived.usageSnapshot().fake.map((w) => w.id), ['five-hour']);
  });
```

Match the suite's own construction of `SessionManager` and its temp `dir`.

- [ ] **Step 5: Run it and watch it fail**

Run: `yarn test:unit`
Expected: FAIL — `usageSnapshot()` on the revived manager is `{}`.

- [ ] **Step 6: Load and save the map**

In `SessionManager.init()`, after the index is read:

```ts
    const usage = await this.store.readUsage();
    for (const [providerId, windows] of Object.entries(usage.providers)) {
      this.usage.set(providerId, new Map(windows.map((w) => [w.id, w])));
    }
```

and in `persist()`, after `writeIndex`:

```ts
    // usageSnapshot() prunes reset windows on the way out, so a file written
    // now cannot resurrect one on the next load.
    await this.store.writeUsage({ providers: this.usageSnapshot() });
```

- [ ] **Step 7: Run it and watch it pass**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 8: Write the failing hydrate tests**

In `src/test/unit/message-router.test.ts`, extend the existing `ready` test (or add one beside it) asserting the emitted `hydrate` carries `usage` from the manager. In `src/test/unit/reducer.test.ts`:

```ts
  test('hydrate seeds usageByProvider so a reload paints immediately', () => {
    const state = reduce(initialState, {
      t: 'hydrate', sessions: [], layout: { orientation: 'vertical', panes: [] },
      snapshots: [], catalog: [],
      usage: { fake: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62 }] },
    });
    assert.deepStrictEqual(state.usageByProvider.fake, [
      { id: 'five-hour', label: 'Session (5h)', usedPercent: 62 },
    ]);
  });
```

Any other `hydrate` literal in the reducer or DOM tests will now fail to type-check without the new field — update them all to pass `usage: {}`.

- [ ] **Step 9: Run them and watch them fail**

Run: `yarn test:unit`
Expected: FAIL — `hydrate` has no `usage` property.

- [ ] **Step 10: Carry it on `hydrate`**

In `src/protocol/messages.ts`:

```ts
  | { t: 'hydrate'; sessions: SessionSummary[]; layout: PaneLayout;
      snapshots: SessionSnapshot[]; catalog: ProviderInfo[];
      /** Per provider, the last window set the host knew. Empty on a fresh install. */
      usage: Record<string, UsageWindow[]> }
```

In `src/host/message-router.ts`'s `ready` case, add `usage: this.manager.usageSnapshot(),` to the `hydrate` emit. In `src/webview/reducer.ts`'s `hydrate` case, replace `usageByProvider: {}` with `usageByProvider: msg.usage` and extend the "explicit, not `...state`" comment to say that usage is host state and therefore always taken from the message.

- [ ] **Step 11: Run every gate**

Run: `yarn lint && yarn check-types && yarn run compile && yarn test:unit && yarn test:dom`
Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: persist account usage and carry it on hydrate

A window set is true as of the last event — utilization only moves when the
plan is used — so the host stores it in a usage.json sibling of index.json and
replays it into hydrate. A reload now paints real percentages before anything
runs, which is the case the pull could never serve.

Windows past their resetsAt are pruned on the way out rather than persisted
and re-shown: after a reset the number is known to be wrong and the next event
may be hours away."
```

---

### Task 4: The context ring tells one story

Handoff Part 2, item 2. The popover header derives its percentage from the pulled breakdown while the ring and its ≥80% danger styling read the pushed `contextPercent`, so a session can render a destructive `86%` beside a `50% used` header.

The fix is to make them the same measurement rather than to pick a favourite: when the host serves a `request-context`, it has *just* fetched a breakdown, so it updates `contextPercent` from it and notifies. The client then has one source — `contextPercent` — for the ring, the danger state and the header, and it is never staler than the rows beneath it.

**Files:**
- Modify: `src/host/agent-session.ts` (`contextBreakdown()`, ~lines 253-260)
- Modify: `src/webview/components/context-ring.tsx` (~lines 147-193)
- Test: `src/test/unit/agent-session.test.ts`, `src/test/dom/context-ring.test.tsx`

**Interfaces:**
- Consumes: `SessionState.contextPercent` (unchanged shape), `sink.changed()`.
- Produces: nothing new. `AgentSession.contextBreakdown()` gains the side effect of refreshing `contextPercent`.

- [ ] **Step 1: Write the failing host test**

In `src/test/unit/agent-session.test.ts`:

```ts
  test('serving a breakdown refreshes contextPercent from the same measurement', async () => {
    const provider = new FakeProvider(undefined, {
      context: {
        systemPercent: 12, memoryPercent: 4, conversationPercent: 27, freePercent: 57,
        memoryFiles: [],
      },
    });
    const session = /* construct as this suite already does, with `provider` */;
    await session.contextBreakdown();
    assert.strictEqual(session.state.contextPercent, 43);
    assert.ok(sink.changedCalls > 0);
  });
```

Use the suite's existing session construction and fake sink; `changedCalls` stands for whatever counter that sink already exposes.

- [ ] **Step 2: Run it and watch it fail**

Run: `yarn test:unit`
Expected: FAIL — `contextPercent` is `undefined`.

- [ ] **Step 3: Refresh on the way out**

In `AgentSession.contextBreakdown()`:

```ts
  async contextBreakdown(): Promise<ContextBreakdown> {
    if (!this.run.contextBreakdown) {
      throw new Error('This provider does not report context usage');
    }
    const breakdown = await this.run.contextBreakdown();
    this.rememberMemoryFiles(breakdown);
    // The ring, its danger threshold and the popover header must all be the
    // same measurement — a destructive 86% ring beside a "50% used" header is
    // two numbers claiming to be one thing. We have just paid for a fresh
    // breakdown, so the pushed value is updated from it here rather than left
    // to drift until the next turn-end.
    this.applyContextPercent(breakdown);
    return breakdown;
  }
```

Extract the body of `refreshContextPercent`'s post-await work into a shared private method so both callers use one implementation:

```ts
  private applyContextPercent(breakdown: ContextBreakdown): void {
    if (this.disposed) { return; }
    const next = Math.round(100 - breakdown.freePercent);
    if (this._state.contextPercent === next) { return; }
    this._state.contextPercent = next;
    this._state.updatedAt = Date.now();
    this.sink.changed();
  }
```

`refreshContextPercent()` keeps its best-effort try/catch and its `if (!breakdown) return;` guard and then calls `applyContextPercent(breakdown)`.

- [ ] **Step 4: Run it and watch it pass**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 5: Write the failing DOM test**

In `src/test/dom/context-ring.test.tsx`:

```ts
  test('the header, the ring label and the danger label agree on one number', async () => {
    const { sendFromHost, container } = await mountRing({ contextPercent: 86 });
    sendFromHost({
      t: 'context-breakdown', id: 's1',
      result: { ok: true, breakdown: {
        systemPercent: 20, memoryPercent: 6, conversationPercent: 60, freePercent: 14,
        memoryFiles: [],
      } },
    });
    // Open the popover the way the existing tests do, then:
    const shown = [...container.querySelectorAll('[data-testid="context-percent"]')]
      .map((n) => n.textContent);
    assert.deepStrictEqual(new Set(shown).size, 1);
  });
```

Adapt to the file's real helpers and selectors — mount through the real `StoreProvider`, drive with genuine messages, and if there is no existing test id for the percentage, assert on the rendered text instead of adding markup for the test.

- [ ] **Step 6: Use one source in the component**

In `src/webview/components/context-ring.tsx`, delete `headerPercent` (~line 155) and render the header from `percent` (`pane.summary.contextPercent`), the same value the ring and `danger` already read. Keep the popover *rows* on the pulled breakdown — they are a decomposition, not a total, and the file's existing "never re-derive a total from the rows" comment stays true. Update the comment beside the header to record why the header no longer derives its own number.

- [ ] **Step 7: Run the gates and the detector**

Run: `yarn lint && yarn check-types && yarn test:unit && yarn test:dom`
Run: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/context-ring.tsx`
Expected: all pass, detector exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "fix: make the context ring and its popover header one number

The header derived its percentage from the pulled breakdown while the ring and
its >=80% danger styling read the pushed contextPercent, so a session could
render a destructive 86% beside a '50% used' header. Serving a breakdown now
refreshes contextPercent from that same fetch, and the component reads that one
value for all three."
```

---

### Task 5: Memory rows share their slice's denominator

Handoff Part 2, item 3. Rows are computed as `tokens / maxTokens` while the Memory slice is a largest-remainder share of `usedPercent`. In clamped or over-full cases a single row can exceed the slice above it, which looks like a bug on screen even though the doc comment warns against re-deriving totals.

**Files:**
- Modify: `src/providers/claude/map-context.ts` (`toContextBreakdown`, ~lines 86-128; the `share` helper becomes unused)
- Modify: `src/providers/types.ts` (`ContextBreakdown`'s doc comment, ~lines 90-105)
- Modify: `docs/superpowers/specs/2026-08-13-usage-and-context-design.md` (the sentence under the data model, ~line 52)
- Test: `src/test/unit/map-context.test.ts`

**Interfaces:** no signature changes. `memoryFiles[].percent` changes meaning from "share of the window" to "share of the window, allocated within the Memory slice" — the two agree except at the rounding and clamping edges, which is the point.

- [ ] **Step 1: Write the failing test**

In `src/test/unit/map-context.test.ts`:

```ts
  test('memory rows sum to exactly memoryPercent', () => {
    const b = toContextBreakdown({
      totalTokens: 30_000, maxTokens: 100_000,
      memoryFiles: [
        { path: '/a', tokens: 3_333 }, { path: '/b', tokens: 3_333 }, { path: '/c', tokens: 3_334 },
      ],
    });
    assert.strictEqual(
      b.memoryFiles.reduce((sum, f) => sum + f.percent, 0), b.memoryPercent,
    );
  });

  test('no row exceeds its slice, even when the context is over-full', () => {
    const b = toContextBreakdown({
      totalTokens: 200_000, maxTokens: 100_000,
      memoryFiles: [{ path: '/big', tokens: 150_000 }],
    });
    assert.ok(b.memoryFiles[0].percent <= b.memoryPercent);
  });

  test('a file too small to round up still gets a row, at 0 — the UI reads it as <1%', () => {
    const b = toContextBreakdown({
      totalTokens: 50_000, maxTokens: 100_000,
      memoryFiles: [{ path: '/big', tokens: 49_000 }, { path: '/tiny', tokens: 1 }],
    });
    assert.strictEqual(b.memoryFiles.length, 2);
    assert.strictEqual(b.memoryFiles[1].percent, 0);
  });
```

- [ ] **Step 2: Run them and watch the first two fail**

Run: `yarn test:unit`
Expected: FAIL on the sum and on the over-full case.

- [ ] **Step 3: Allocate rows inside the slice**

In `toContextBreakdown`, replace the `memoryFiles` mapping in the main return with a largest-remainder allocation over the same `memoryPercent` the Memory row shows:

```ts
  // The rows are an allocation *within* the Memory slice, not an independent
  // tokens/maxTokens calculation. Sharing the slice's denominator is what
  // stops a single row from rendering larger than the slice it sits under
  // when the window is clamped or over-full.
  const filePercents = largestRemainder(
    res.memoryFiles.map((f) => f.tokens), memoryTokens, memoryPercent,
  );
```

```ts
    // A file rounding to 0 stays in the list: it is present in the context,
    // and the UI renders 0 as `<1%` rather than dropping the row.
    memoryFiles: res.memoryFiles.map((f, i) => ({ path: f.path, percent: filePercents[i] })),
```

`largestRemainder` already returns all-zeros when its `base` is `<= 0`, which is exactly right for "memory files exist but nothing is attributed". Delete the now-unused `share` helper. The early-return branch for an unusable window size is unchanged — it already emits `percent: 0` rows.

- [ ] **Step 4: Run them and watch them pass**

Run: `yarn test:unit`
Expected: PASS. Existing `toContextBreakdown` assertions that hard-code a row percentage may shift by a point; verify any change is the new allocation being correct rather than a regression, then update the expectation.

- [ ] **Step 5: Correct the two doc comments and the spec**

`ContextBreakdown` in `src/providers/types.ts` says `memoryFiles` percentages sum to `memoryPercent` "subject to rounding". They now sum exactly; say so, and keep the `<1%` note. Make the same correction to the spec sentence under the data model.

- [ ] **Step 6: Run the gates**

Run: `yarn lint && yarn check-types && yarn test:unit && yarn test:dom`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "fix: allocate memory rows inside their own slice

Rows were tokens/maxTokens while the Memory slice was a largest-remainder
share of usedPercent, so in clamped or over-full cases one row could render
larger than the slice above it. Both now come from the same allocation, and
the rows sum to memoryPercent exactly rather than approximately."
```

---

### Task 6: Close the branch

**Files:** none necessarily — this is verification and, if the critique finds something, whatever it names.

- [ ] **Step 1: Run every gate from clean**

Run: `yarn lint && yarn check-types && yarn run compile && yarn test:unit && yarn test:dom`
Expected: all pass. Unit and DOM counts should be at or above the 363/152 baseline net of the pull tests deleted in Task 2 — account for the difference explicitly rather than assuming.

- [ ] **Step 2: Confirm the pull is actually gone**

Run: `grep -rn "request-usage\|usageWindows\|UsageResult\|EXPERIMENTAL_MAY_CHANGE" src/`
Expected: no hits. Any survivor is dead code the deletion missed.

- [ ] **Step 3: Run the impeccable critique over the webview**

Invoke the `impeccable` skill's `critique` over `src/webview`, and compare against the previous run in `.impeccable/critique/`. The score is expected to go up, never down — the strip lost an entire effect apparatus and gained an honest empty state.

- [ ] **Step 4: Hand the manual verification to the maintainer**

The spec records that integration coverage is deliberate manual verification. Report to the user, explicitly, what to exercise in a dev host (`yarn dev`): the strip populated from `FakeProvider`'s two pushed windows *before sending anything*; the strip after a window reload; the ring geometry and popover placement at a 300px sidebar width; and clicking a memory path (`PanelViewProvider.openFile`, which has no automated coverage at any level).

- [ ] **Step 5: Update `CLAUDE.md` if the architecture table drifted**

`src/providers/claude/map-context.ts`'s row says "SDK context/usage responses → `ContextBreakdown` / `UsageWindow[]`". It now maps one event to one window; correct the row. Add `src/shared/usage-windows.ts` to the table.

- [ ] **Step 6: Commit anything Steps 3-5 produced**

```bash
git add -A
git commit -m "docs: bring CLAUDE.md in line with the push-fed usage seam"
```

---

## Self-Review

**Spec coverage.** Amendment banner → the whole plan. Data model (`usage-window` event, no `AgentRun.usageWindows`) → Tasks 1 and 2. "Where the numbers come from" (`SDKRateLimitEvent`, one event one window, unlabelable events dropped, `toUsageWindows` deleted) → Tasks 1 and 2. Protocol (`request-usage` gone, `usage-windows` a push with no not-ok arm, `hydrate` carries the map) → Tasks 2 and 3. Flow (sink → manager map → ordered → ungated emit → persisted sibling file → reset pruning → no client timers) → Tasks 2 and 3. UI (one quiet state, honest for both audiences, fixed height) → Task 2. Reducer (replace wholesale, `hydrate` seeds) → Tasks 2 and 3. Testing (map-events, reducer, session-manager, message-router, FakeProvider scripting) → Tasks 1-3; the deliberate non-automation of integration → Task 6 Step 4. Context half unchanged → only Tasks 4 and 5 touch it, both as correctness fixes the handoff names.

**Placeholders.** None. Every code step carries the code. Three steps deliberately say "match the suite's existing idiom" for a test harness whose exact helper names the plan does not restate (`settle()`, `emitted()`, `mountStrip()`, `mountRing()`, the fake sink's counter) — these exist in the tree and must be read, not invented; that is a direction to look, not a gap.

**Type consistency.** `usageWindow(providerId, window)` is the sink method name in Task 2 Steps 3, 4 and in `SessionManager`. `usageSnapshot()` is the accessor in Task 2 Step 4 and consumed in Task 3 Steps 6, 10. `orderWindows` is produced in Task 1 Step 10 and consumed in Task 2 Step 4. `toUsageWindow` (singular) is produced in Task 1 Step 3 and consumed in Task 1 Step 8; `toUsageWindows` (plural) is only ever deleted. `StoredUsage.providers` is `Record<string, UsageWindow[]>` in Task 3 Steps 3, 6 and matches `usageSnapshot()`'s return. `applyContextPercent` in Task 4 Step 3 is used by both `contextBreakdown()` and `refreshContextPercent()`. `largestRemainder(weights, base, total)` in Task 5 Step 3 matches its existing signature at `map-context.ts:58`.
