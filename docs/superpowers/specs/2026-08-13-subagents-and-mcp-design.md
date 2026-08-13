# hiiiid-code — Subagent and MCP Observability

**Date:** 2026-08-13
**Status:** Design approved, pending implementation plan
**Builds on:** [2026-08-13-vscode-agent-manager-design.md](2026-08-13-vscode-agent-manager-design.md)

## Overview

The v1 agent panel renders a transcript of flat items. A turn that dispatches
subagents renders as a single stalled tool card with nothing to watch, and a
tool call from an MCP server renders under its raw wire name with no indication
of where it came from. Both read as the agent hanging.

This adds observability for the two: subagent runs become nested, live,
collapsible cards inside their parent tool call, and MCP tool calls carry their
server's identity. It also surfaces MCP server health, which is invisible today
— a server that failed to start simply means the agent silently lacks tools.

This is a read-path feature. It renders what already happens.

## Goals

- A turn dispatching subagents never reads as a hang, collapsed or expanded.
- See what a subagent is doing while it does it.
- Attribute every MCP tool call to its server, permanently.
- Make a failed or unauthorized MCP server visible.

## Non-goals

- **Configuration.** Which MCP servers connect and which subagents exist stay
  where they are — the CLI's own config files. No settings UI.
- **Subagents in the roster.** The roster means "conversations I own". You
  cannot send to a subagent.
- **A dedicated subagent pane.** Planned successor work; see Future.
- **Nesting past one level.**
- **Transcript virtualization.** Deferred in v1 and still deferred; the bounded
  child window below removes the case that would have forced it.

## Sequencing

This lands after v1. v1 ships flat transcripts and this is a second spec, plan,
and implementation cycle.

The cost is code-level rework in modules v1 writes: `AgentSession`,
`protocol/messages.ts`, and the webview transcript components all get edited.
The stored format is unaffected — see Persistence.

## One level of nesting is a constraint, not a simplification

Claude subagents cannot spawn subagents. Fixing depth at 1 in the data model
removes recursion from patches, persistence, and rendering, all of which would
otherwise need tree-shaped handling for a tree that is never more than two deep.

If a provider ever nests deeper, children beyond depth 1 flatten into their
nearest depth-1 ancestor. The model does not grow.

## Provider seam

`AgentEvent` gains one optional field on three variants and one new variant.

```ts
export type AgentEvent =
  | { kind: 'session';    resumeToken: string }
  | { kind: 'text';       delta: string }
  | { kind: 'thinking';   delta: string }
  | { kind: 'tool-start'; id: string; name: string; input: unknown; parentId?: string }
  | { kind: 'tool-end';   id: string; ok: boolean; output: unknown; parentId?: string }
  | { kind: 'permission'; id: string; name: string; input: unknown; parentId?: string }
  | { kind: 'turn-end';   reason: 'done' | 'interrupted' | 'error'; error?: string }
  | { kind: 'usage';      inputTokens: number; outputTokens: number }
  | { kind: 'mcp-servers'; servers: McpServerStatus[] };

export type McpServerStatus = {
  name: string;
  state: 'pending' | 'connected' | 'failed' | 'needs-auth';
  toolCount?: number;
  error?: string;
};
```

**`parentId` is a tool-use id, not a session id.** When present it is the id of
the `tool-start` that spawned the subagent — the `Task` call. That id is already
in the stream, so a child needs no correlation event and the parent needs no
"subagent started" announcement. Claude's SDK carries `parent_tool_use_id` on
subagent messages; `map-events.ts` copies it across.

**Permission carries `parentId`.** A subagent asking to run `Bash` is still the
user's decision, and the approval card must render where the work is happening.
This is the case that makes collapsed-but-live summaries mandatory rather than
pleasant: a collapsed subagent must be able to report that it is blocked.

**Subagent prose is dropped at the seam.** `map-events.ts` discards `text` and
`thinking` from any message carrying a parent id. Only the subagent's tool
activity enters the transcript.

Filtering above the seam instead would allocate those events and throw them
away, and would leave a tempting one-line change that quietly reintroduces the
token volume. Dropping at the boundary makes the decision structural: showing
subagent prose becomes a deliberate seam change.

Nothing is lost that the user reads. The subagent's returned result arrives
anyway as the parent `Task` tool's `tool-end` output. The intermediate prose is
largely restated parent context; the tool sequence is the part worth watching.

**`mcp-servers` is a snapshot, not a delta.** The full array each time, at init
and on any state change. Servers number in the single digits, so diffing is
complexity for nothing, and replace-whole makes hydrate and live update the same
code path.

## Transcript items

Tool items gain children and a parsed server. Nothing else changes shape.

```ts
type ToolItem = {
  id: string; kind: 'tool';
  name: string; input: unknown;
  state: 'running' | 'ok' | 'error';
  output?: unknown;
  startedAt: number; endedAt?: number;
  children?: TranscriptItem[];     // depth 1 only; 'tool' | 'permission' | 'error'
  mcpServer?: string;              // parsed from an mcp__ name
};
```

`children` is absent for the overwhelming majority of tool calls, so the common
item stays its current size.

**`mcpServer` is parsed once, host-side, at item creation.** Split
`mcp__<server>__<tool>`; store the server, store the bare tool name in `name`.

Parsing in the webview instead would re-run per render, and the same parse is
needed host-side anyway for the status strip. More importantly, resolving the
badge against a live server list at render time would blank out or mislabel
historical cards the moment a user removed a server. The denormalized value is
what makes a transcript a record: removing an MCP server cannot rewrite what
already happened.

A malformed `mcp__` name that does not split into three parts is left as-is with
no `mcpServer`, rather than guessed at.

## Patches

```ts
type TranscriptPatch =
  | { op: 'append';  item: TranscriptItem; parentItemId?: string }
  | { op: 'delta';   itemId: string; field: 'text' | 'thinking'; delta: string }
  | { op: 'replace'; item: TranscriptItem; parentItemId?: string };
```

`delta` needs no parent. Subagent prose never reaches the transcript, so deltas
are top-level by construction — the seam-level filtering paying for itself in
the wire format.

**A parent always exists before its children.** The parent `Task` item is
appended at `tool-start`, and a subagent cannot emit anything before the tool
call that spawned it. The webview resolves `parentItemId` against items it
already holds: no orphan buffer, no reconciliation queue.

**A child with an unknown parent is promoted to top-level.** Defensive, for a
provider reporting a parent id we never saw. Losing nesting degrades rendering;
dropping the item would hide work the agent actually did.

**The card's summary is derived, not transmitted.** Child count, elapsed time,
and running count all compute from `children` and the timestamps already on each
item. No `summary` field to drift from what it summarizes.

## Persistence

**Children are written inline with their parent, on parent settle.** One JSONL
line remains one settled top-level item.

While a subagent runs, its children live in memory on the parent `ToolItem`.
When the parent `Task` receives its `tool-end`, the whole item — children
included — appends as a single line.

Writing children as their own lines with a `parentItemId` would break the
property that line count tracks item count, which is what makes backward paging
cheap. `load-more` pages by top-level items; a subagent that ran 200 tools must
count as one unit, or a page becomes a single card.

Memory cost is one subagent's children held until it finishes — bounded by
subagent length, not session length, and those items are already resident for
rendering.

**Migration is a no-op.** `children` and `mcpServer` are optional and additive,
so v1-written lines parse unchanged: absent `children` reads as "no subagent",
which is true of every v1 line. No rewrite pass, no version field.

**An abandoned subagent is still written.** Interrupt, provider crash, or a turn
ending mid-`Task` means `tool-end` never arrives. On `turn-end` of any reason,
every unsettled parent flushes with the children it has and `state: 'error'`.
Otherwise a crashed turn silently discards subagent work the user watched happen.

## MCP server status

Live provider state only. `AgentSession` holds the last `mcp-servers` snapshot
in memory; it is not persisted and does not survive the run.

An archived session therefore shows **no strip at all** — not an empty one.
There is no run to ask, and a stale snapshot presented as current would be a
lie. The historical record lives on the tool cards, which is where it belongs.

A consequence worth naming: a card's badge and the strip can legitimately
disagree. The card says `github`; the strip, after the user removed that server,
does not list it. The card is a record of what happened, the strip is a
statement about now. Both are correct.

## UI

### Subagent card

Collapsed by default:

```
▸ Task  Explore  ·  12 tools  ·  34s  ·  running
```

Expanded, rendering children inline in the parent transcript:

```
▾ Task  Explore  ·  213 tools  ·  4m 12s  ·  done
     showing last 10 of 213
     …
```

- **Collapsed stays live.** Tool count and elapsed tick while collapsed. This is
  the feature: a row reading `12 tools · 34s` is not a hang; a static `Task` row
  is.
- **Collapsed renders zero children.** Only the derived summary. Five collapsed
  subagents must not cost what five open ones do — this is the load the feature
  exists for.
- **Awaiting approval force-opens the card** and marks the header. A blocking
  decision buried in a collapsed row would be strictly worse than v1, where it
  was at least visible at top level.
- **Manual collapse is sticky per item.** Once the user collapses a card that
  force-opened, it stays collapsed even if another permission arrives; the
  header still shows the blocked state. Otherwise the card fights the user.

### Bounded child window

An expanded card renders **at most the last `SUBAGENT_CHILD_WINDOW` children**
(10), inline, with no scroll container of its own.

The card is a live activity indicator, not a log reader. Ten rows show what the
subagent is doing now; more would imitate a full log view that does not exist
yet.

This choice removes work rather than deferring it:

- **No nested scroll.** The pane's `MessageScroller` stays the only scroller, so
  its anchor and autoscroll behaviour — which v1 deliberately bought a library
  for — is untouched.
- **No windowing library.** Ten real DOM nodes need none, so the project keeps
  its vendored-source-only property.
- **Live tail is free.** The window *is* the last N, so the newest child is
  always rendered. No follow logic, no scrolled-up detection, no local scroll
  state.
- **Card height is bounded by construction** — ten collapsed rows, not two
  hundred.

The full child list is still held on the item and still persisted in full. Only
rendering is capped.

**No overflow affordance in this version.** No dead button, and no "show all"
that dumps 213 rows into the transcript and undoes the cap. `showing last 10 of
213` is a statement of fact; the escape hatch arrives with the pane (see Future).

`SUBAGENT_CHILD_WINDOW` is a single named constant, so tuning it after watching
real runs is a one-line change.

### MCP tool card

Server badge plus bare tool name: `github` `create_pr`. The badge is muted, not
coloured per server — per-server colour needs a palette, collides with status
colours, and buys nothing when the name is adjacent.

### Status strip

In the pane chrome, collapsed to a dot and count (`3 MCP`). The dot takes the
worst state across servers, so one failed server is visible without expanding.
Clicking expands a list: name, state, tool count, error text where present.

`needs-auth` renders an explanatory line, not a button. The extension host
cannot run an OAuth flow, so the honest action is "authorize in a terminal".

Absent entirely when a session has no MCP servers. No empty state for the common
case.

## Testing

All against `FakeProvider` — no SDK, no VS Code, no network.

- **Nesting assembly** — scripted `parentId` sequences; children land under the
  right parent, depth never exceeds 1, unknown-parent children promote to
  top-level.
- **Prose filtering** — `map-events.ts` table test: a subagent message with text
  and thinking produces no event; the same message without a parent id produces
  the deltas. This is the test that keeps the seam decision from eroding.
- **Abandoned subagent** — interrupt mid-`Task`; one line written, children
  present, `state: 'error'`.
- **Round-trip** — write a session containing subagents, reload, paging returns
  identical items with children intact; a v1-format line with no `children`
  still parses.
- **MCP parsing** — `mcp__github__create_pr` splits; `mcp__weird` is left alone
  with no `mcpServer`.
- **Status snapshot** — successive `mcp-servers` events replace wholesale; the
  strip is absent when the array is empty.
- **Child window** — an item with 213 children renders 10; the rendered 10 are
  the last 10; a collapsed card renders 0.

## Risks

**SDK exposure is unverified and this feature is entirely downstream of it.**
Two facts need checking before the plan is written:

1. Subagent messages carry `parent_tool_use_id` (or equivalent) through the
   streaming interface.
2. MCP server state is readable at init.

This is the same risk class as v1's SDK risk but sharper. v1 degrades gracefully
if a detail differs; here, no parent correlation means no nesting feature at all.

**The first step of the implementation plan is a spike against the installed
package, not implementation.**

If MCP state proves unreadable, the status strip is cut and attribution ships
alone — attribution depends on nothing but the tool name, so it cannot be
blocked by this.

**Collapsed-but-live is a render-cost trap.** Child items stream into the host
whether or not a card is open. If a collapsed card renders its children, the
cost of five collapsed subagents equals five open ones. This works fine in
testing and degrades under exactly the multi-agent load the feature targets,
which is why it is stated as a rule in the UI section and covered by a test.

## Future

**A subagent promoted into its own pane.** It reuses the existing split-pane
machinery, is read-only, stays owned by the parent session, and is a
`MessageScroller` — so it handles an unbounded child list with the same
machinery every other transcript uses. That is the natural home for the full
child list the bounded window declines to show.

This was considered and rejected during design as part of this scope: what made
it expensive was inventing a session-shaped view for something that is not a
session. Once this spec ships, the child list already exists as a first-class
array on the item, which is most of what that view needs.

**Transcript virtualization** stays deferred. The bounded child window removes
the case that would have forced it. If it returns, it returns for long sessions,
which is a different problem from this one.
