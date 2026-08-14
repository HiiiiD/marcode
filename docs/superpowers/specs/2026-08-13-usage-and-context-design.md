# Usage and Context Design

Show, per session, how full the model's context window is and what the startup context contains; show, per provider, how much of each account usage window is spent. Percentages only — no token counts anywhere in the UI.

> **Amended 2026-08-14.** The account-usage half was originally specified as a pull:
> the webview asked, the host forwarded to a live run, the run called the SDK's
> experimental usage method. That shape shipped and was wrong. `ClaudeProvider` builds its
> `Query` lazily on the first `send()`, so after a window reload every session is restored
> but unstarted, the first answer is an error, and nothing retries — the strip read as
> broken until the user typed a message.
>
> The replacement is a push. `SDKRateLimitEvent` is a first-class member of the SDK's
> `SDKMessage` union, carries exactly the two fields the strip renders, and arrives through
> the event stream the provider already maps. It is not experimental, unlike
> `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`, which this design
> abandons. A probe `Query` built at panel open was considered and rejected: it spawns a CLI
> subprocess for a user who may never send a message.
>
> The sections below are written in the amended shape. **The context half is unchanged** —
> `Query.getContextUsage()` carries no experimental warning and is inherently per-session,
> so the ring, the popover and `request-context` / `context-breakdown` stay exactly as
> first specified.

## Problem

A session gives no signal about how close it is to the context limit, and none about what was loaded before the first message. The user cannot tell whether `CLAUDE.md` was picked up, whether a global memory file is contributing, or how much room is left before the conversation is compacted. Account usage against plan limits is equally invisible: the only way to learn a window is exhausted is to hit it.

## Goals

- A per-session ring shows the share of the context window in use, live across all sessions.
- Clicking the ring shows what occupies the window: system prompt, memory files, conversation, free.
- Memory file paths are listed and open in the editor on click.
- A panel-level strip shows each account usage window the provider reports, as a percentage with its reset time.
- Every surface degrades to an honest empty state when the provider reports nothing.

## Non-goals

- Token counts, cost, or any absolute number in the UI. Percentages only. Tokens are an internal detail of the provider's own computation.
- Listing files the agent read during the session (Read/Grep/Glob results). The context view covers startup context only.
- Listing MCP servers, tool definitions, or skills as separate rows. Tool definitions are folded into the system prompt slice.
- A compaction UI, a "clear context" action, or any mutation. This feature is read-only.
- Cross-session or historical usage charts.

## Data model

In `src/providers/types.ts`:

```ts
export interface UsageWindow {
  /** Provider-defined: 'five-hour' | 'weekly' | … */
  id: string;
  /** Human label, e.g. 'Session (5h)'. */
  label: string;
  /** 0..100. */
  usedPercent: number;
  /** Epoch ms, when the provider knows it. */
  resetsAt?: number;
}

export interface ContextBreakdown {
  /** System prompt and tool definitions, as one slice. */
  systemPercent: number;
  memoryPercent: number;
  conversationPercent: number;
  freePercent: number;
  /** Absolute paths, with each file's share of the window. */
  memoryFiles: { path: string; percent: number }[];
}
```

The four `*Percent` fields sum to 100. `memoryFiles` percentages sum to `memoryPercent`, subject to rounding; the UI never re-derives a total from the rows.

Percentages are computed inside the provider. Only the provider knows the model's context window size and the text of its own system prompt, so nothing above `AgentProvider` sees tokens.

Provider surface — one optional method for context, and one event for usage:

```ts
export interface AgentRun {
  // …existing
  /** Startup context inventory for this conversation. */
  contextBreakdown?(): Promise<ContextBreakdown>;
}

// In the AgentEvent union:
| { kind: 'usage-window'; window: UsageWindow }
```

`contextBreakdown` sits on the run because memory resolution depends on the session's `cwd`.

Usage does not sit on the run at all. Account limits are a property of the *account*, and the provider emits one `usage-window` event per window whenever that window's utilization changes. A provider that never emits them (a `FakeProvider` profile, or a Claude session on an API key, Bedrock or Vertex) simply produces no windows, which is a state the strip renders rather than an error. There is no `AgentRun.usageWindows`, no request, and no reply — the host holds the last window it was told about and the webview renders it.

### Where the numbers come from (Claude)

`@anthropic-ai/claude-agent-sdk` supplies both directly:

- `Query.getContextUsage()` → `SDKControlGetContextUsageResponse`: `categories[]`, `totalTokens`, `maxTokens`, `percentage`, `memoryFiles[{ path, type, tokens }]`, `systemPromptSections[]`, `messageBreakdown`. `ContextBreakdown` is derived from it — memory from `memoryFiles`, conversation from `messageBreakdown`, system as the remainder of `totalTokens`, free from `maxTokens`.
- `SDKRateLimitEvent` (`sdk.d.ts:4408`, verified against `@anthropic-ai/claude-agent-sdk@0.3.228`) → `{ type: 'rate_limit_event'; rate_limit_info: SDKRateLimitInfo; session_id }`, emitted whenever rate-limit info changes. `SDKRateLimitInfo` carries `rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage'`, `utilization?: number` (0–100), `resetsAt?: number` (epoch ms), plus overage and status fields this feature does not read.

Each event describes **one** window, not a set. `map-events.ts` maps it to a `usage-window` `AgentEvent` using the id and label table already in `map-context.ts`; an event whose `rateLimitType` is absent, whose `utilization` is absent, or whose type has no entry in that table is dropped rather than rendered under a guessed label. The overage windows are out of scope for the same reason the overage fields are.

`toUsageWindows` and its experimental-response mapper are deleted. `toContextBreakdown` and the id/label table stay.

## Protocol

`src/protocol/messages.ts` re-exports both types and gains one state field and four messages.

```ts
export type { UsageWindow, ContextBreakdown };

// On SessionState:
/** 100 - freePercent. Absent until the first turn ends. */
contextPercent?: number;
```

Webview → host:

```ts
| { t: 'request-context'; id: SessionId }
| { t: 'open-file'; path: string }
```

Host → webview:

```ts
| { t: 'context-breakdown'; id: SessionId;
    result: { ok: true; breakdown: ContextBreakdown }
          | { ok: false; reason: string } }
| { t: 'usage-windows'; providerId: string; windows: UsageWindow[] }
```

`context-breakdown` is a reply and carries its key, so a late reply for a closed session is discardable by the reducer rather than mis-applied.

`usage-windows` is not a reply. It is the host announcing the full, ordered window set it currently knows for a provider — a snapshot, never a delta, so the webview replaces rather than merges. It has no `ok: false` arm: under a push there is no request that can fail, and "we have not been told anything" is a state, not an error. `hydrate` carries the same map for every provider the host knows, so a reload paints real numbers before any session runs.

## Flow

**Ring — pushed.** On `turn-end`, `AgentSession` calls `run.contextBreakdown?.()`, stores `100 - freePercent` as `contextPercent`, and lets the existing `session-status` / `sessions-changed` patch carry it. Those messages are ungated, so the ring stays current in every session, not only visible ones. A run without the method leaves the field `undefined` and emits no extra traffic.

**Popover — pulled.** Opening the popover posts `request-context`. `MessageRouter` forwards to `SessionManager.contextBreakdown(id)`, which awaits the run and replies once. The host caches nothing; the webview keeps the last reply per session and renders it while a refetch is in flight.

**Usage strip — pushed.** A `usage-window` event reaches `AgentSession`, which hands the window to its sink. `SessionManager` keeps the latest window per `(providerId, window.id)`, orders the set by the provider's own label table, and emits `usage-windows` to the webview ungated — the same way `sessions-changed` goes out, because account usage is not a per-pane concern.

The map is persisted beside `index.json` in its own file. It is account data, not session data, so it does not belong on `SessionState`, and a restored session must not carry a percentage that has since moved.

A persisted window is true "as of the last event": utilization only changes when the plan is used, so last-known is the truth until the next event arrives. The one exception is reset — a window whose `resetsAt` has passed is dropped on load and on emit rather than shown at a stale percentage, since after a reset the number is known to be wrong and the next event may be hours away.

The webview holds no timers and runs no effects for this. The strip is a render of `usageByProvider`.

**`open-file`** is the only new call into the `vscode` API (`window.showTextDocument`). It is handled in `PanelViewProvider`, not `MessageRouter`, so the router keeps its no-`vscode` invariant and stays unit-testable. The router therefore ignores `open-file`; `PanelViewProvider` intercepts it before delegating.

A provider method that rejects is caught in `SessionManager` and converted to `{ ok: false, reason }`. Nothing rejects across `postMessage`.

## UI

Two feature components and two vendored primitives. `Tooltip` and `Popover` are not vendored yet; both come from the Base UI-backed registry into `src/webview/components/ui/`.

### `context-ring.tsx`

Sits in the composer's toolbar row, right-aligned beside the send button, about 16px. An SVG arc drawn with `stroke-dasharray` over a `text-muted` track. The stroke is `text-primary` and shifts to `text-destructive` above 80%. It is focusable, `role="button"`, labelled `Context 43% used`.

Hovering shows a `Tooltip` with the same sentence. Clicking opens a `Popover` of roughly 280px:

```
Context                              43% used
──────────────────────────────────────────────
System prompt        ▓▓▓░░░░░░░░░░░░       12%
Memory               ▓░░░░░░░░░░░░░░        4%
  CLAUDE.md                                 3%
  ~/.claude/CLAUDE.md                       1%
Conversation         ▓▓▓▓▓▓░░░░░░░░        27%
Free                 ░░░░░░░░░░░░░░        57%
```

Memory files are indented rows under the Memory row: basename in normal weight, parent directory dimmed, the whole row clickable and posting `open-file`. With no memory files, the Memory row renders alone at 0%.

While the first reply is outstanding the rows are skeletons. An `ok: false` reply renders one muted line carrying the reason. `contextPercent` absent renders a dashed empty ring whose tooltip reads `Context usage unavailable`.

### `usage-strip.tsx`

One row pinned to the bottom of the panel, below the pane grid. Each window renders as a small ring, its label, its percentage, and its reset time when `resetsAt` is set.

```
◕ Session (5h) 62%    ◔ Weekly 18% · resets in 3d
```

Rings share the tooltip and colour rules of the context ring. When the roster spans several providers the strip groups windows by provider, labelled with `displayName`.

A provider with no known windows gets one quiet muted line. Under a push there is exactly one such case and it must be worded honestly for both audiences it covers: an account that has not yet run a turn in this install, and an API-key/Bedrock/Vertex session that will never report plan limits at all. The push carries no signal that separates them — the second is indistinguishable from the first until an event that never comes — so the copy must not assert either. It says what is true of both: nothing has been reported. Neither the old `No plan limits` (which asserts the account has none) nor the old failure line survives; the error state is gone with the request.

The strip is always present and keeps its fixed height, so the panel's layout does not shift when the first event lands.

### Reducer

`src/webview/reducer.ts` gains two maps:

```ts
contextBySession: Record<SessionId, ContextResult | undefined>;
usageByProvider: Record<string, UsageWindow[] | undefined>;
```

A `context-breakdown` for an unknown session is ignored. Deleting a session deletes its entry. `contextPercent` rides in on `sessions-changed` and updates the ring without touching a cached breakdown.

`usage-windows` replaces the entry for its provider outright, including with an empty array. `undefined` means the host has said nothing about that provider; the two are the same on screen, and the distinction exists only so the reducer never has to invent a value. `hydrate` seeds the whole map at once.

## Testing

Unit, under `yarn test:unit`:

- `reducer.test.ts` — a `context-breakdown` is stored under the right key, `ok: false` stored rather than dropped, a reply for a deleted session ignored, `contextPercent` updates independently of a cached breakdown; `usage-windows` replaces a provider's entry (including with an empty array) and `hydrate` seeds the map.
- `message-router.test.ts` — `request-context` reaches the manager with the right identifier; a throwing provider method produces `{ ok: false }` and never a rejection; `open-file` is not handled by the router.
- `map-events.test.ts` — a `rate_limit_event` maps to one `usage-window` with the table's id and label; events missing `rateLimitType` or `utilization`, and the overage types, produce nothing.
- `session-manager` — a `usage-window` event lands in the map under its provider, a second event for the same window id replaces rather than appends, the emitted set is ordered by the label table and goes out ungated, a window past its `resetsAt` is dropped, and the map survives a reload through the persisted sibling file; `turn-end` recomputes `contextPercent`; a run without `contextBreakdown` leaves it `undefined` and emits no extra patches.

`FakeProvider` gains scripted `usage-window` events and a scripted breakdown so both surfaces work in development without an API key. A second scripted profile emits neither, which is what exercises the empty states.

**Integration coverage is deliberately not automated.** The original spec asked for a `@vscode/test-cli` test — panel loads, ring renders, popover opens against the fake breakdown, clicking a memory path opens that document — and the plan that executed it retired that requirement in its own self-review, which was a process fault: a plan should not silently discharge an obligation its own spec set. Recorded here instead as an explicit decision taken 2026-08-14: the maintainer verifies these surfaces by hand in a dev host (`yarn dev`, which scripts `FakeProvider` with a populated breakdown and windows). The obligation is discharged, not forgotten. `PanelViewProvider.openFile` consequently has no automated coverage at any level, which is the known cost of this choice.

## Staging

The composer, pane group and Claude provider all exist as of `187302a`, so nothing here is blocked. The protocol and provider-surface changes land first, the host wiring next, and the two UI surfaces last and independently of each other.
