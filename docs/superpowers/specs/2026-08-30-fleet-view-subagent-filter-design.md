# Fleet view: subagents-only, filtered to one session

**Status:** design, approved 2026-08-30.

## The problem

Fleet view shipped 2026-08-28 as a grid of session cards — status, model, one-line activity
— mirroring `SessionPicker`'s roster but at a glance. Real usage says that's the wrong
content: a session card here duplicates what the sidebar's own header already shows, while
the thing Fleet has no answer for at all is "what are this session's subagents doing" — the
one view a 300-500px sidebar genuinely can't hold (a session running several subagents drowns
its own transcript). Four pieces of feedback, one shape:

- Fleet should show only subagents belonging to sessions currently split in the sidebar — not
  every roster session, only what the user has visible.
- Fleet needs a session filter: one session's subagents at a time, not a merged view.
- Fleet should show only subagents — never plain conversation items.
- `SubagentCard`'s "Open full transcript" (in the sidebar transcript) should land in Fleet,
  not just replace the sidebar pane in place.

## The decision

Fleet's session grid is retired. In its place: a forced session picker (no merged/all-session
default — empty state until one is picked) scoped to the sidebar's own visible panes, then a
list of that session's subagent tool-calls (running by default, a toggle reveals
finished/failed too), each opening into the existing unwindowed `SubagentTranscript` view.
The sidebar's in-pane subagent drill-in is removed outright — its one caller now opens Fleet
instead.

**"Active sessions" = the sidebar's visible panes, and that scope comes for free.** Fleet
already runs its own `MessageRouter` instance (`FleetPanel`) against the *same*
`SessionManager`, and `ready`'s handler snapshots exactly `manager.layout().panes` into
`hydrate.snapshots` — the identical set the sidebar hydrates from, since there is one
`PaneLayout`. `session-patch` is already gated to that same visible set (existing CLAUDE.md
invariant). So Fleet's subagent list is live and correctly scoped the moment `FLEET_WANTS`
admits `session-patch` and `layout-changed` — no new gating logic, no new wire message for
scope.

## Architecture

### Wire

`FLEET_WANTS` (`src/host/post-bus.ts`) gains two message types:

```
FLEET_WANTS = (msg) =>
  msg.t === 'sessions-changed' || msg.t === 'session-status' ||
  msg.t === 'session-patch' || msg.t === 'layout-changed';
```

`session-patch` is what makes the subagent list live (new subagent starts, tool children
arrive, one finishes). `layout-changed` is what keeps the session picker in sync when the
user changes the sidebar's split without reopening Fleet. Both already fan out through
`PostBus`, ungated beyond this predicate — nothing new to build, only to admit.

One new `WebviewToHost` message, sent from the sidebar (not Fleet):

```
{ t: 'open-fleet-subagent'; sessionId: SessionId; itemId: string }
```

Posted by `SubagentCard`'s "Open full transcript" affordance (via
`SubagentDrillInContext`, see below) instead of setting local pane state.

### Host

`PanelViewProvider` intercepts `open-fleet-subagent` the same way it already intercepts
`open-fleet` — needs the `vscode` API (`FleetPanel.open`) that `MessageRouter` may not import.
`FleetPanel.open()` gains an optional focus target:

```ts
open(focus?: { sessionId: SessionId; itemId: string }): void
```

If the panel already exists, `open()` reveals it and posts a `fleet-focus-subagent` message
directly through its own router's `emit` (same rail `hydrate`/`editor-context` already use —
outside `PostBus`, in direct answer to this interaction, not a broadcast). If the panel is
being created fresh, the focus target is held and sent right after the first `hydrate` this
panel's own `ready` handler produces, once the target session's snapshot is guaranteed to be
in it — sending it any earlier would ask the client to select a subagent it has no items for
yet.

### Client (`src/fleet/`) — corrected during planning

The original 2026-08-28 design gave Fleet its own narrow `FleetState`/`reduceFleet`
specifically to avoid pulling in the sidebar's full transcript state. That no longer holds:
`PermissionCard` and `ToolCard` — the components this spec reuses "verbatim" to render a
subagent's transcript — import `useStore` from `../store` as a **fixed module reference**
(`src/webview/store.tsx`), not a value passed down through props. That module's `StoreContext`
is a specific `React.createContext` instance; a second, separate context (Fleet's own
`FleetState`/`useStore`, matching shape or not) is a different object; and
`useContext` on the wrong context throws `useStore must be used inside StoreProvider`
regardless of what Fleet's tree provides. So `SubagentTranscript` cannot actually render
inside Fleet's own store — only inside the genuine `src/webview/store.tsx` provider.

The fix: Fleet drops its own store/reducer entirely and mounts the real one.
`src/fleet/store.tsx` and `src/fleet/reducer.ts` are **deleted**; `src/fleet/main.tsx`
imports `StoreProvider` from `../webview/store`, and every Fleet component imports
`useStore` from the same place `PermissionCard` already does. This gives `FleetApp` the
full `ClientState` (`byId`, `layout`, `sessions`, `catalog`, …) — most of it unread, exactly
as `PaneGroup` itself only reads a fraction of `ClientState` for any one pane. `PermissionCard`
gains nothing new to depend on either: its only use of `state` is
`state.byId[sessionId]?.summary.cwd`, which is correct and present under Fleet for the same
reason it's correct under the sidebar — both hydrate from the same
`SessionManager`/`MessageRouter`.

`FLEET_WANTS` is unaffected by this correction — it still governs exactly which
`HostToWebview` messages reach the Fleet client's `PostBus` registration
(`sessions-changed` / `session-status` / `session-patch` / `layout-changed`), regardless of
which reducer consumes them.

Fleet's own UI state — `selectedSessionId`, `selectedSubagentId`, `showSettled` — has no home
in `ClientState` (correctly: the sidebar has no use for it) and is not part of this reuse. It
lives as local `useState` inside `FleetApp`, alongside a second, independent
`onHostMessage` subscription (the same exported function `StoreProvider` itself uses,
`src/webview/vscode-api.ts`'s listener is `addEventListener`-based and supports multiple
independent subscribers) that watches for the one message type `ClientState`'s own reducer
has no case for and correctly ignores: `fleet-focus-subagent`.

`FleetApp` (`src/fleet/fleet-app.tsx`) restructures around three states:

1. **No session selected:** a list of the visible sessions (`layout.panes`, titles from
   `byId[...].summary`) as the picker; picking one sets `selectedSessionId`. Genuinely empty
   (`layout.panes.length === 0`) reuses the existing "No sessions yet" copy.
2. **Session selected, no subagent open:** that session's top-level `role: 'tool'` items
   filtered to `tool.kind === 'subagent'`, further filtered to `state === 'running'` unless
   `showSettled` is on (a toggle in the header, next to a breadcrumb back to the picker). Each
   row reuses `subagentLabel`/`summarizeSubagent`/`formatElapsed` from `subagent-window.ts` —
   the same summary line `SubagentCard`'s collapsed header already computes, so Fleet's list
   and the sidebar's inline card never describe one subagent two different ways.
3. **Subagent open:** `SubagentTranscript` (`src/webview/components/subagent-transcript.tsx`),
   unchanged, wrapped in its own `MessageScrollerProvider` (Fleet has no other scroller
   competing for it, unlike `PaneGroup` where the provider is shared with the normal
   transcript). `onBack` clears `selectedSubagentId` only, keeping the session selected.

No new component does the actual transcript rendering — `SubagentTranscript`,
`ToolCard`, `PermissionCard` are reused verbatim, which is also what keeps permission
answering (a blocked subagent, approved from Fleet) working with zero new wiring: those
cards post the same `permission-answer` message keyed by `sessionId`/`requestId` regardless
of which webview mounted them, and `FleetPanel`'s own `MessageRouter.handle` already routes
it like every other panel.

### Sidebar cleanup

`PaneGroup`'s `drilledIn` local state, its `SubagentDrillInContext.Provider`, and the
now-two-branch `openItem`/`SubagentTranscript` render path are removed — the pane always
renders `SessionHeader` + `Transcript` + `Composer`. `SubagentDrillInContext` itself
(`src/webview/components/subagent-drill-in-context.ts`) changes from "how a pane replaces
itself" to "how a `SubagentCard` reaches the host": its callback signature stays
`(itemId: string) => void`, but the implementation posts
`{ t: 'open-fleet-subagent', sessionId, itemId }` instead of setting pane state. The context
still exists (and its documented "absent in a host with no pane to drill into" default stays
correct — it now just doesn't apply, since posting a message needs no pane at all — the
context becomes: provided in `PaneGroup`, harmless no-op anywhere `SubagentCard` is mounted
without it, e.g. a future review-tab use). Concretely, `PaneGroup` provides:

```tsx
<SubagentDrillInContext.Provider value={(itemId) => post({ t: 'open-fleet-subagent', sessionId: pane.sessionId, itemId })}>
```

`SubagentCard` itself is unchanged — it already calls `useOpenSubagentTranscript()` and
invokes it with the item id; only what that callback *does* changes.

## What stays ephemeral, and why

`selectedSessionId`, `selectedSubagentId`, `showSettled` are exactly the same shape of state
CLAUDE.md's review-tab invariant and the original fleet-view design already establish for
this codebase: a reading position over a fleet that keeps changing underneath it. None of it
is persisted; a reload always returns Fleet to "pick a session."

## Testing

**Unit.**
- `FLEET_WANTS` predicate gains `session-patch`/`layout-changed`, mirroring the existing
  `REVIEW_WANTS`/`FLEET_WANTS` tests — asserts the fleet client still never receives, e.g.,
  `fleet-diff`.
- `hydrate`/`session-patch`/`layout-changed` handling itself needs no new reducer tests —
  `src/webview/reducer.ts`'s existing suite already covers it, since Fleet now consumes that
  same `reduce()` unmodified. What's new is the small `fleet-focus-subagent` listener
  (`useState` + `onHostMessage`) — tested by mounting `FleetApp` and asserting the selection
  it produces, not by unit-testing a reducer case.
- Subagent filtering (running vs. `showSettled`) as a pure function beside
  `active-subagents.ts`'s existing precedent, so it unit-tests without mounting `FleetApp`.
- `FleetPanel.open(focus)`: reveals + emits directly when already open; holds and sends after
  first hydrate when opened fresh.
- `PanelViewProvider`'s `open-fleet-subagent` interception, mirroring the existing
  `open-fleet` test.

**DOM.**
- Fleet harness (extending the existing one in `src/test/dom/fleet-harness.tsx`): picker
  shown with no selection; selecting a session narrows to its subagents; toggling
  `showSettled` reveals a finished one; opening a subagent renders `SubagentTranscript`
  content; `onBack` returns to the list with the session still selected.
- Sidebar: `SubagentCard`'s "Open full transcript" posts `open-fleet-subagent` (asserted on
  the posted message, not on any pane state) — replaces the old in-pane drill-in DOM test.
- `layout-changed` reaching a live Fleet client updates its picker without a fresh `ready`.

## Risks

- **The Fleet bundle now includes the sidebar's full `ClientState` reducer**, not a narrow
  slice — a real bundle-size increase, and the trade CLAUDE.md's original "no `byId`, no
  layout, no composer" framing for the fleet client explicitly wanted to avoid. Accepted here
  because the alternative (decoupling `PermissionCard`/`ToolCard` from `useStore` so any host
  can supply `post`/`cwd` through props) is a real refactor across every caller of those two
  components, for a payload-size concern in an editor-tab webview that is not on any
  performance-sensitive path (unlike the sidebar, which is visible during every keystroke of
  every session). Revisit only if Fleet's bundle size becomes an actual complaint.
- **Fleet now holds transcript content**, which the original design's "never transcript,
  always summary" framing explicitly avoided. That framing is superseded by this spec, not
  violated by accident: showing subagent tool-call detail is the whole point of this change,
  and it stays bounded to the visible set exactly as `session-patch` already is everywhere
  else in this codebase.

## Explicitly out of scope

- Sort/search within a session's subagent list — the running/settled toggle is the only
  filter; revisit if a session routinely runs enough subagents at once to need it.
- Renaming `open-fleet-subagent` invocations to also work from the review tab or anywhere
  else `SubagentCard` might someday mount — `SubagentDrillInContext`'s no-op default already
  covers that until it's asked for.
- Persisting `selectedSessionId` — see "What stays ephemeral."
