# Subagent transcript pane, and a fleet-wide agent view

**Status:** design, approved 2026-08-28.

## The problem

Two gaps, both about seeing more than one conversation's worth of a fleet at once.

**A subagent is a second conversation with no way to read it.** A `Task`-spawned
subagent's tool calls already arrive tagged with `parent_tool_use_id`, get nested under the
parent's `Task` item as `children[]`, and are fully retained there. But
`SubagentCard` only ever renders the last `SUBAGENT_CHILD_WINDOW = 10` of them inline, with
no way to see the rest — the data survives, the view doesn't. For anything longer than a
handful of tool calls, most of a subagent's work is invisible.

**There is no way to see the whole roster at once.** Multi-session awareness today is
`PaneGroup`'s split over whichever sessions are "visible", plus `SessionPicker`'s flat
dropdown (name + toggle, one aggregate "N needs you" badge). Neither answers "what is every
agent in my fleet doing right now" at a glance — the thing Claude's own multi-agent view
does well.

## The decision

**Subagent pane:** clicking a subagent card opens its full tool-call history **in place of**
the pane it was opened from — same transcript renderer as a top-level session, no cap, with
a breadcrumb back to the parent. This needs no new data pipeline: `item.children` already
carries the complete list to the webview today: the window is a client-side rendering
choice, not a server-side truncation, so removing it is a client-only change plus one bit of
ephemeral "what is this pane showing" state.

**Fleet view:** a new editor-area `WebviewPanel`, `marcode.fleet.open`, mirroring
`ReviewPanel`'s architecture exactly — its own bundle, its own narrow client state, its own
`PostBus` registration on the same two already-ungated messages the review tab already uses.
A grid of session cards (status, one-line activity, needs-you flag); clicking a card reveals
the sidebar and puts that session in its split.

## Architecture — subagent pane

### Why no protocol change

`PaneLayout.panes` is `{ sessionId, size }[]`, and it is **persisted** (`index.json`,
restored on `SessionManager` construction, round-tripped through `hydrate`/`set-layout`).
Drilling a pane into a subagent's transcript is a reading position in a list that is still
being written — the same shape of thing as review's collapse state and opened-row set,
which CLAUDE.md already establishes must stay client-only: restoring it on reload would
restore an opinion about content that may no longer be what's on screen (the subagent may
have finished, the parent session may have moved on). So this stays **out of** `PaneLayout`
entirely, in a purely local webview map: `Record<PaneIndex, { subagentItemId: string } |
undefined>`, alongside the sidebar's other ephemeral view state. Reload always returns every
pane to its session, never mid-drill.

### Rendering

A pane with a drill-in active renders the same transcript component that a session pane
does, sourced from `session.byId[sessionId].items[...].children` narrowed to the one
`subagentItemId`, unwindowed. Permission cards inside it dispatch through the existing wire
messages unchanged — they are the same `TranscriptItem`s with the same ids, just addressed
through a different pane. No new `WebviewToHost`/`HostToWebview` message is needed for this
either.

A small header replaces the pane's normal title bar while drilled in: `← [session title]` /
`Subagent: [agent] · [model]`. Clicking the breadcrumb clears that pane's map entry.

### Trigger

`SubagentCard` gains an "Open full transcript" affordance in its header (present once the
card has more children than the inline window shows), which sets that pane's map entry
rather than opening a new pane — consistent with "replace in place, not an added split."

### `SUBAGENT_CHILD_WINDOW`

Stays as the inline-card default. It is now a "preview before you open it" limit, not the
only way to see a subagent's work.

## Architecture — fleet view

### The host

`src/host/fleet-panel.ts`, structured identically to `review-panel.ts`: one
`vscode.WebviewPanel` (`viewColumn: Beside`), a `WebviewPanelSerializer` for reload, its own
`MessageRouter` instance answering that panel's `ready`/`hydrate`, and a `PostBus`
registration.

```
FLEET_WANTS = ['sessions-changed', 'session-status']
```

The same two messages the review tab already receives — both already fan out ungated to
every registered client, so this reuses an existing invariant rather than widening it. No
`fleet-diff`, no `session-patch`: the fleet view never needs transcript content, so it never
asks for it, and the visible-set gate for `session-patch` is untouched.

### The client

A fourth esbuild entry, `src/fleet/main.tsx` → `dist/fleet.js` + `dist/fleet.css`, matching
the review tab's precedent of one bundle per surface rather than branching one bundle on a
boot message. Its own narrow state — `sessions: SessionSummary[]`, `ready` — with no `byId`
transcript store, no layout, no composer. `@/components/ui/*` stays shared, picked up by the
Tailwind esbuild plugin's import-graph scan with no config change.

### The card

One card per roster session (archived sessions excluded — this is "what's running", not the
roster picker): title, provider/model chip, `StatusBadge` (idle/busy/attention/failed,
reusing `src/webview/status.ts`'s mapping), and an activity line.

**Activity line is a new field, not a new subscription.** `SessionState` gains
`activityLabel?: string` — a short host-computed label ("Running `Edit` ·
tool-render.ts", "Waiting for approval: Bash", "Idle"), maintained by `AgentSession`
alongside its existing `recomputeWaitingStatus()` (same place `status` is already derived,
so no new event wiring — it updates on the same `tool-start`/`tool-end`/approval transitions
that already run `sessions-changed` through the bus). This keeps the fleet view honest about
"never transcript, always summary": the label is a derived string, not the underlying tool
call.

### Opening a session from the fleet view

Clicking a card posts `{ t: 'focus-session', id }` to the fleet panel's own router. The
handler calls the existing `SessionManager.setVisible`/`setLayout` (adds the session to the
current pane layout if absent, otherwise leaves it) — no new manager method for the add
itself. Reaching the sidebar, though, needed one: `setVisible` only emits a session snapshot,
and a session the sidebar has already seen once (opened, then hidden or closed) is never
auto-appended to its pane layout by the client's own reconcile effect (see `app.tsx`'s
`knownSessionIdsRef`), so nothing before this feature told that pane to come back. The fix is
a `HostToWebview` message, `{ t: 'layout-changed'; layout: PaneLayout }`, emitted by
`SessionManager.setLayout()` itself right after it assigns `this.paneLayout` — every caller
of `setLayout`, not just this one, now echoes to the sidebar, and `focus-session`'s
`setVisible`/`setLayout` pair rides that same rail rather than a special case of its own.
Alongside that, `vscode.commands.executeCommand('workbench.view.extension.mar-code')`
reveals the sidebar. This is push-only: the fleet tab does not read back the sidebar's pane
state, so there's no cycle to reason about between two panels each owning layout.

### Opening it

`vscode.commands.registerCommand('marcode.fleet.open', () => fleet.open())`, plus a trigger
in the sidebar's header (near `SessionPicker`) posting the same open. Idempotent like
`ReviewPanel.open()` — reveals a live tab rather than making a second.

## What stays ephemeral, and why

Both new pieces of state — a pane's subagent drill-in, and (implicitly) the fleet tab's own
scroll/sort position if any is added later — are reading positions over a fleet that keeps
changing underneath them. Neither is persisted, for the same reason review's collapse state
isn't: a restored opinion about a transcript that has since moved on is worse than asking
again.

`activityLabel`, by contrast, **is** part of `SessionState` and travels with it — it is a
live derived fact about the session right now, not a reading position, so it belongs on the
wire the same way `status` does.

## Testing

**Unit.**
- `AgentSession.recomputeWaitingStatus` (or wherever `activityLabel` is set) — one label per
  transition: idle, running with a named tool, awaiting-approval with the pending tool's
  name.
- `FLEET_WANTS` predicate filtering on `PostBus`, mirroring the existing `REVIEW_WANTS` test
  — the load-bearing assertion is that the fleet client never receives `session-patch`.
- `focus-session` handling in the fleet router: adds to layout without duplicating an
  already-visible session.

**DOM.**
- A fleet harness beside `src/test/dom/harness.tsx`, same discipline as review's: state
  arrives as genuine `HostToWebview` messages through a real `StoreProvider`, assertions
  read posted messages back, never a hand-built state object.
- Sidebar: drilling a pane into a subagent and back via breadcrumb, asserted by which
  transcript items render, not by inspecting DOM nodes directly (`assert.strictEqual` on
  booleans/strings/counts only, per the existing RAM-guard invariant).
- `SubagentCard`'s "open full transcript" affordance appears only past the window threshold.

## Risks

- **A fourth bundle is a fourth CSP surface.** Mitigated the same way review's is: both new
  and existing panels construct through `webview-html.ts`, never a hand-copied CSP.
- **`activityLabel` drifts from `status` if updated in a different code path.** Keeping it
  set inside `recomputeWaitingStatus()` (the existing single place `status` is derived)
  rather than scattered at each call site is what prevents that.
- **The fleet tab restored mid-`init()`** — same pre-`ready` `Loading…` state `ReviewPanel`
  already needed for the same reason (`WebviewPanelSerializer` can restore before the
  roster exists).

## Explicitly out of scope

- Sending new input into a running subagent — the SDK gives no channel to steer a
  `Task`-spawned subagent mid-run; the pane is read-only plus permission answers, matching
  what a subagent can actually receive today.
- Sort/filter/search on the fleet grid — start with the plain grid, revisit once real usage
  shows what's needed (mirrors review's own filter/keyboard work being a later pass, not
  day one).
- Nested subagents-of-subagents — the SDK doesn't produce them (Claude subagents can't spawn
  subagents), so depth stays capped at 1 as it is today.
