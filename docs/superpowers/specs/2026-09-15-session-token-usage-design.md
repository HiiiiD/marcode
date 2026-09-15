# Session token usage: input/output/cache read/write, normal vs subagent

## Problem

`SessionState.usage` (protocol/messages.ts:198) already exists but only holds
`{ inputTokens, outputTokens }`, overwritten on every `usage` `AgentEvent` —
a latest-turn snapshot, not a running total, and cache-read/cache-creation
numbers are read off the Claude SDK's `result.usage` (map-events.ts:293-309)
only to be logged to `lifecycleDebug` and then discarded. Nothing persists a
session's cumulative token spend, and there's no way to see what a spawned
subagent cost versus the main conversation.

## Goals

- Cumulative, persisted totals per session: input, output, cache-read,
  cache-creation tokens.
- Split into `normal` vs `subagent` buckets where the provider's data can
  actually support it.
- Visible in the existing context dialog (opened from `context-ring.tsx`).
- Survives a window reload, for free, off the existing `index.json` write
  path.

## Non-goals

- Per-turn history / a scrollable log of usage over time. Cumulative totals
  only, matching how `SessionState.usage` already works today.
- A uniform normal/subagent split across all three providers. The source
  data doesn't support it uniformly (see below) — this spec ships the split
  only where a provider can actually back it, and never invents a number.
- Any change to the percentage-based context ring / usage-strip surfaces.
  This is a new, adjacent section in the context dialog, not a replacement
  for either.

## Per-provider data reality

Investigated before designing, because the three providers report usage
completely differently:

- **Claude**: `result.usage` (map-events.ts:291-309) is **per-turn**, not
  cumulative — each top-level `result` message reports that turn's tokens
  only. No `parentId`, so the SDK gives no way to attribute any of it to a
  subagent; subagent token spend is folded into the same turn's total.
- **Codex**: `thread/tokenUsage/updated`'s `tokenUsage.total`
  (wire.ts:59-69) is **already cumulative**, per thread. Subagents are
  genuine separate threads (`rejoinSubagentThread`, codex-run.ts:174-189),
  each firing its own `thread/tokenUsage/updated` — but `codex-run.ts:245-255`
  currently drops a child thread's `usage` notifications entirely, forwarding
  only its `tool-start`/`tool-end`.
- **OpenCode/ACP**: the only usage-shaped signal is `usage_update` →
  `toContextBreakdown` (map-updates.ts:121-134), a `used`/`size` **context
  occupancy** total — not real input/output/cache-read/write counts, and
  explicitly "one undifferentiated total" per that file's own comment.
  `subagent-watch.ts` never reads or forwards usage for child sessions.

Consequence: Claude and OpenCode cannot support a normal/subagent split from
their data at all. Codex can, but only after a deliberate change to stop
dropping child-thread usage. The design below treats "cumulative total" as
the thing every provider can report (Claude, Codex: yes; OpenCode: no — see
below) and "subagent split" as Codex-only for now.

## Data model

```ts
// src/providers/types.ts — AgentEvent's 'usage' kind
interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

type UsageEvent = {
  kind: 'usage';
  normal: UsageTotals;
  subagent?: UsageTotals;   // present only when the provider can attribute it
};
```

```ts
// src/protocol/messages.ts — SessionState.usage
usage?: {
  normal: UsageTotals;
  subagent?: UsageTotals;
};
```

`subagent` absent means "this provider can't tell you," never a faked zero.
A session with no turns yet has `usage: undefined` (same absent-means-nobody-
answered pattern as `probing` in the catalog invariant).

## Emission semantics: adapters normalize, host just replaces

The three providers' native numbers behave differently (per-turn delta vs.
already-cumulative), so each adapter is responsible for turning its native
signal into a running cumulative total *before* emitting `usage` — the host
never sums anything, it just takes the latest event as current truth. This
keeps the accumulation logic colocated with the provider that knows its own
semantics, instead of a central reducer trying to special-case three
providers.

- **Claude** (`src/providers/claude/`): `ClaudeRun` keeps a running
  `UsageTotals` accumulator across the session's turns, adding each `result`
  message's per-turn `usage` fields (all four: input, output,
  `cache_read_input_tokens`, `cache_creation_input_tokens`) into it, and
  emits the accumulator's current value as `normal` on every `usage` event.
  No `subagent` field — never set.
- **Codex** (`src/providers/codex/`): `CodexRun` no longer drops a rejoined
  child thread's `thread/tokenUsage/updated` notifications
  (codex-run.ts:245-255 changes to forward them, tagged). Main thread's
  latest `tokenUsage.total` → `normal`. Each known subagent thread's latest
  `tokenUsage.total`, summed across any concurrently open subagent threads →
  `subagent`. `map-events.ts` widens its mapping to also read
  `cachedInputTokens` (currently dropped) — `reasoningOutputTokens` is a
  Codex-specific reasoning breakdown, not one of the four tracked fields, and
  stays out of scope.
- **OpenCode/ACP** (`src/providers/opencode/`, `src/providers/acp/`): no
  `usage` `AgentEvent` is emitted at all — the underlying data isn't the
  right shape (context occupancy, not token-type counts) to report honestly
  as `UsageTotals`. `SessionState.usage` stays `undefined` for these
  sessions.

## Persistence

No new storage. `StoredIndex.sessions` is already `SessionState[]`
(transcript-store.ts:15-17), serialized whole to `index.json` on every write
that touches session state. Widening `SessionState.usage` rides that
existing path — optional field, no `TRANSCRIPT_VERSION` bump needed (an
older reader ignoring an unknown field is fine; there's no required-field
break here, unlike the v1→v2 tool-item change that motivated the version
bump in the first place).

`agent-session.ts`'s `case 'usage':` handler changes from the current
overwrite-with-latest-turn-snapshot to storing the event's `normal`/
`subagent` totals directly (the adapter already did the accumulation, so
this stays a plain assignment, not new host-side summing logic).

## UI

Extend the popover opened from `context-ring.tsx` (the existing per-session
context dialog) with a new "Token usage" section below the context-window
breakdown it already shows:

- Four rows for `normal`: Input, Output, Cache read, Cache write — raw
  counts (the documented percentage-only invariant already carves out one
  exception for the context window's token line; this is a second, narrow
  exception for the same reason a percentage can't express it: an absolute
  spend has no natural denominator to be a percentage *of*).
- A visually secondary sub-block, "Subagents," with the same four rows, shown
  only when `session.usage?.subagent` is present (Codex sessions with at
  least one spawned subagent this run). Absent entirely for Claude/OpenCode
  sessions and for Codex sessions that never spawned a subagent.
- When `session.usage` is `undefined` entirely (OpenCode, or a session with
  no turns yet), the section renders one line: "Not tracked for this
  provider" / "No usage yet" — never a row of zeros standing in for "we
  don't know."

## Testing

- **Unit (`yarn test:unit`)**:
  - `map-events.ts` (Claude): a multi-turn scripted sequence of `result`
    messages accumulates correctly into a running `normal` total; no
    `subagent` field ever appears.
  - `map-events.ts` / `codex-run.ts` (Codex): a main-thread-only sequence
    reports `normal` only; a sequence with a rejoined subagent thread's
    `tokenUsage/updated` notifications reports both `normal` and `subagent`,
    summed correctly across concurrent subagent threads; a closed subagent
    thread's last-known total still counts (no silent drop on thread close).
  - `agent-session.ts`: the `usage` case assigns the event's totals directly
    (no accumulation at this layer) and round-trips through `index.json`
    serialization.
- **DOM (`yarn test:dom`)**: the context dialog's new section — renders four
  rows for `normal`, renders the `subagent` sub-block only when present,
  renders the fallback line when `usage` is `undefined` — driven through
  `sendFromHost` per the existing DOM-test convention.

## Open items for the implementation plan

None outstanding — every question raised during design has an answered
decision recorded above.
