# Marcode TUI: multi-session (phase C)

Builds on [the TUI design](2026-09-30-marcode-tui-design.md) and the [roadmap](../roadmap-tui.md). v1 shows exactly one session. C shows several in split panes, adds mouse support, handoff seeds and forking, and settles what "visible" means once `marcode__spawn_session` adds sessions on its own.

## Goal

A terminal user sees and drives several sessions at once, in resizable split panes whose arrangement survives a restart. An agent that spawns a session gets a pane for it rather than a hidden or half-visible one.

Success: split the focused pane, open a second session beside it, drag the divider, quit and relaunch with the same tree; a session spawned by an agent appears in a pane; fork a session at a message and hand a session off to a new one, all from keys or the mouse.

## Decisions

- **"Visible" = the layout's leaves.** The `PaneLayout` is the single source of truth, as in the webview. Whenever the leaf set changes the TUI posts `set-layout`, then `set-visible` with exactly the leaf ids, then `focus-pane`. The host is unchanged.
- **Spawned sessions get a pane.** The host still calls `setVisible(existing + spawned)`. The TUI store watches `sessions-changed` and `session-snapshot` for ids it has not seen and runs `reconcilePaneLayout`, then posts the result. The new leaf is `transient`, so it goes away when the session closes.
- **Layout reuse.** `client-core/layout-tree` is used as is. `reconcilePaneLayout` moves from `src/webview/components/pane-layout.ts` into `client-core` and the old path re-exports it (the same move `layout-tree` made).
- **Persistence.** The tree persists in `layout.tui.json` through `SessionManager.setLayout`, which already round-trips per host. `launchPlan` already resumes from `focusedSessionId` and the leaves; launch now restores every pane. v1's "replace the root with one leaf on each focus" is removed.
- **Pane UX.** Roster toggles plus a `Ctrl+W` chord prefix. No auto-grid.
- **Handoff and fork:** keys and the new-session dialog.

## Visible-set rules

| Event | Layout effect | Posted |
|---|---|---|
| Open from roster, session has a leaf | none; focus moves | `focus-pane` |
| Open from roster, no leaf | `placeSession`: first empty leaf, else a sibling after the focused pane | `set-layout`, `set-visible`, `focus-pane` |
| Hide (`x`, `Ctrl+W x`) | `removeSession` | `set-layout`, `set-visible` |
| Session closed or deleted | host runs `emptySession`; a transient leaf is removed | echoed as `layout-changed` |
| Spawn, fork or create | `reconcilePaneLayout` places the arrival | `set-layout`, `set-visible` |
| Focus change | none | `focus-pane` |

Focus is client-local (`local-focus`), as in the webview. `focusedSessionId` rides on the layout the host persists.

**Minimum size.** A pane needs 40 columns by 8 rows. When the terminal cannot fit the tree at that size, the view renders `maximizeSizes` around the focused pane: the others shrink to a one-line peek strip (glyph and title). This is view-only; stored sizes never change. The roster marks a session that has a leaf but no room with a `+` badge.

## UI

- **`PaneTree`** renders a `LayoutNode` recursively: a split is a flex `<box>` (row or column), each child's `flexGrow` is its `size`. A leaf is a `Pane`.
- **`Pane`** is a bordered box: a title row (status glyph, title, `host·pid` when foreign, `!` when an approval or question waits, `x` to hide), the `Transcript`, and the `BottomSlotView` for that session. An empty leaf shows "open a session from the roster".
- **Focus.** Only the focused pane's composer, transcript keys and prompts take input. A pane with a pending approval or question shows it but cannot answer until focused; `Tab` skips to a pane that needs you. The status line and the model, mode and effort dialogs stay bound to the focused pane.
- **Roster.** Enter focuses a shown session or places it. A row shows a leaf marker and the `+` overflow badge.

### Keys

`Ctrl+W` starts a chord; the next key within 1.5 s is the command. The keymap gets a `pane` zone.

| Chord | Action |
|---|---|
| `h` `j` `k` `l` or arrows | focus the neighbouring pane (by geometry) |
| `\|` / `-` | split right / below; opens the new-session dialog into the new leaf |
| `m` | toggle maximize (view-only) |
| `=` | even sizes |
| `H` `J` `K` `L` | move the focused pane's divider by 5% |
| `x` | hide the focused pane's session |

Transcript `f` forks the selected message. Roster `H` opens the handoff dialog for that row. `Esc` cancels a pending chord.

### Mouse

OpenTUI's mouse events, no new dependency.

- Click a pane to focus it. Click a roster row to focus or place. Click a card header to expand.
- Wheel scrolls the pane under the pointer.
- Drag the one-column divider to resize: a view-only copy during the drag, one `set-layout` on release. Sizes clamp to the minimum.
- Click a title row's `x` to hide.

### Fork

`fork-session {id, itemId}`; the host answers with a `session-snapshot`. The store sees the new id and places it next to the source with `placeSession`, then focuses it. A foreign session cannot be forked (notice). An unknown item is a host no-op.

### Handoff

The `Ctrl+N` dialog gains "Hand off from `<focused title>`" (off by default, disabled with no focus) and a seed prompt line. It posts `create-session` with `seed: { text, handoffFrom }`. The router already emits `handoff-progress`; the status line shows "Summarizing `<title>`…" until `done`. With memory off (always, under Bun) the host falls back to the extractive digest. Roster `H` opens the dialog with that row as the source.

## Code layout

| Path | Responsibility |
|---|---|
| `src/client-core/pane-layout.ts` | `reconcilePaneLayout` and friends, moved from the webview; webview path re-exports |
| `src/client-core/pane-geometry.ts` | Pure: rects from a tree and terminal size, neighbour lookup, divider hit-test, min-size fit check |
| `src/client-core/pane-resize.ts` | Pure: divider drag and keyboard resize, clamped, even sizes |
| `src/tui/view/pane-keys.ts` | Pure: the `Ctrl+W` chord state machine |
| `src/tui/ui/pane-tree.tsx`, `pane.tsx`, `pane-title.tsx`, `divider.tsx` | Rendering and mouse |
| `src/tui/ui/use-pane-layout.ts` | Store glue: place, hide, reconcile arrivals, post `set-layout`/`set-visible`/`focus-pane` |
| `src/tui/ui/store.tsx` | `focus(id)` becomes `placeOrFocus(id)`; no single-leaf layout |
| `src/tui/ui/app.tsx` | Splits into `pane-tree` plus dialog host; stays under ~300 lines |

Files stay under about 300 lines; `app.tsx` sheds its body into `pane-tree`.

## Errors

Errors are state. A failed fork or handoff shows in the notice line and leaves the layout untouched. A stale chord target, divider path or drag is a no-op (the contract `layout-tree.at` already keeps). Nothing rejects across the loopback.

## Invariants kept

- `protocol/messages.ts` stays types-only and is not edited.
- Nothing under `src/tui/` or `src/client-core/` imports `vscode`; `client-core` has no React or DOM.
- Every session-addressed message carries a `SessionId`; there is no implicit current session on the wire.
- Transcript patches reach only visible sessions: the visible set is the leaf set, and the TUI posts it on every change.
- A host never writes a session it does not own: a foreign pane renders read-only and cannot fork.

## Testing

- **Mocha (`yarn test:unit`):** `pane-geometry`, `pane-resize`, `pane-keys`; `reconcilePaneLayout` (existing tests follow the move); `launchPlan` with a multi-leaf layout; roster row model with leaf and overflow markers.
- **`bun test` (`yarn test:tui`):** through the real store and loopback, fed genuine `HostToWebview` messages: a split renders two transcripts; focus moves by chord and by click; a divider drag posts one `set-layout`; a spawned session arriving by `session-snapshot` gets a leaf; fork and handoff post the right messages; a narrow terminal falls back to the maximized view. Only strings and counts reach assertions, never a renderable. Tests wait about 100 ms after a lone Esc.
- **End to end:** real `createHost` with `FakeProvider`: `marcode__spawn_session` yields a visible session with a leaf, and a restart restores the same tree.
- **Manual smoke:** added to `docs/tui.md`: drag a divider, wheel over an unfocused pane, `Ctrl+W` chords, resize the terminal through the minimum-size threshold, relaunch with a saved tree.

## Out of scope

Layout presets UI, drag-to-move panes between slots, grid-shape commands, tabbed panes, roster rename, fork-to-take-over of a foreign session, and everything in phases D to F.

## Risks

- **Mouse in terminals.** Drag and wheel reporting varies; keyboard chords are the complete fallback.
- **Input ownership across panes.** Several composers and transcripts mount at once; only the focused one subscribes to keys. The draft store is already per session.
- **Cost of many live transcripts.** Each visible pane is a live scrollbox. The minimum-size fallback bounds how many are fully laid out.
- **OpenTUI mouse API is young.** Pin to the tested version; the divider's hit-testing is pure so it can be checked without a renderer.
