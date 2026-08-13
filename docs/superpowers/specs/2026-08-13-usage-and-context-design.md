# Usage and Context Design

Show, per session, how full the model's context window is and what the startup context contains; show, per provider, how much of each account usage window is spent. Percentages only — no token counts anywhere in the UI.

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

Provider surface, both members optional and both on `AgentRun`:

```ts
export interface AgentRun {
  // …existing
  /** Startup context inventory for this conversation. */
  contextBreakdown?(): Promise<ContextBreakdown>;
  /** Account usage windows visible from this run. */
  usageWindows?(): Promise<UsageWindow[]>;
}
```

`contextBreakdown` sits on the run because memory resolution depends on the session's `cwd`. `usageWindows` sits there too because the Claude Agent SDK exposes plan limits only from a live `Query` — there is no provider-level entry point. Account limits are nonetheless a property of the *account*, not the session, so the host asks any one live run of a provider and treats the answer as that provider's. A provider with no live run answers `{ ok: false }`.

### Where the numbers come from (Claude)

`@anthropic-ai/claude-agent-sdk` supplies both directly:

- `Query.getContextUsage()` → `SDKControlGetContextUsageResponse`: `categories[]`, `totalTokens`, `maxTokens`, `percentage`, `memoryFiles[{ path, type, tokens }]`, `systemPromptSections[]`, `messageBreakdown`. `ContextBreakdown` is derived from it — memory from `memoryFiles`, conversation from `messageBreakdown`, system as the remainder of `totalTokens`, free from `maxTokens`.
- `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` → `rate_limits.{ five_hour, seven_day, seven_day_opus, … }`, each `{ utilization: 0-100 | null, resets_at: ISO | null }`, plus `rate_limits_available: false` for API-key, Bedrock and Vertex sessions.

The usage method is explicitly experimental and named to discourage reliance, so it is feature-detected at the call site and any throw or absence degrades to `{ ok: false }` rather than propagating.

## Protocol

`src/protocol/messages.ts` re-exports both types and gains one state field and five messages.

```ts
export type { UsageWindow, ContextBreakdown };

// On SessionState:
/** 100 - freePercent. Absent until the first turn ends. */
contextPercent?: number;
```

Webview → host:

```ts
| { t: 'request-context'; id: SessionId }
| { t: 'request-usage'; providerId: string }
| { t: 'open-file'; path: string }
```

Host → webview:

```ts
| { t: 'context-breakdown'; id: SessionId;
    result: { ok: true; breakdown: ContextBreakdown }
          | { ok: false; reason: string } }
| { t: 'usage-windows'; providerId: string;
    result: { ok: true; windows: UsageWindow[] }
          | { ok: false; reason: string } }
```

Both replies carry their key, so a late reply for a closed session or a switched provider is discardable by the reducer rather than mis-applied.

## Flow

**Ring — pushed.** On `turn-end`, `AgentSession` calls `run.contextBreakdown?.()`, stores `100 - freePercent` as `contextPercent`, and lets the existing `session-status` / `sessions-changed` patch carry it. Those messages are ungated, so the ring stays current in every session, not only visible ones. A run without the method leaves the field `undefined` and emits no extra traffic.

**Popover — pulled.** Opening the popover posts `request-context`. `MessageRouter` forwards to `SessionManager.contextBreakdown(id)`, which awaits the run and replies once. The host caches nothing; the webview keeps the last reply per session and renders it while a refetch is in flight.

**Usage strip — pulled, refreshed.** Posts `request-usage` per distinct provider on mount, and again after any session's `turn-end`. The webview debounces to at most one request per provider every few seconds. `SessionManager` resolves the provider to any one live session and asks its run.

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

Rings share the tooltip and colour rules of the context ring. When the roster spans several providers the strip groups windows by provider, labelled with `displayName`. A provider reporting no windows contributes a muted `Usage unavailable for this provider`; the strip is always present, so the panel's layout does not shift.

### Reducer

`src/webview/reducer.ts` gains two maps:

```ts
contextBySession: Record<SessionId, ContextResult | undefined>;
usageByProvider: Record<string, UsageResult | undefined>;
```

A `context-breakdown` for an unknown session is ignored. Deleting a session deletes its entry. `contextPercent` rides in on `sessions-changed` and updates the ring without touching a cached breakdown.

## Testing

Unit, under `yarn test:unit`:

- `reducer.test.ts` — replies stored under the right key; `ok: false` stored rather than dropped; a reply for a deleted session ignored; `contextPercent` updates independently of a cached breakdown.
- `message-router.test.ts` — `request-context` and `request-usage` reach the manager with the right identifiers; a throwing provider method produces `{ ok: false }` and never a rejection; `open-file` is not handled by the router.
- `session-manager` — `turn-end` recomputes `contextPercent`; a run without `contextBreakdown` leaves it `undefined` and emits no extra patches.

`FakeProvider` gains scripted windows and a scripted breakdown so both surfaces work in development and integration without an API key. A second scripted profile implements neither method, which is what exercises the empty states.

Integration, under `@vscode/test-cli`: the panel loads, the ring renders, the popover opens against the fake breakdown, and clicking a memory path opens that document.

## Staging

The composer, pane group and Claude provider all exist as of `187302a`, so nothing here is blocked. The protocol and provider-surface changes land first, the host wiring next, and the two UI surfaces last and independently of each other.
