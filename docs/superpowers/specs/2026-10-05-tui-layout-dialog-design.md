# TUI layout dialog

Roadmap item C, leftover: layout presets UI and grid-shape commands. Drag-to-move, tabbed panes and
fork-to-take-over of a foreign session are separate cycles.

## Goal

Let a terminal user reshape the split panes without hand-splitting: pick a built-in or saved preset, dial in a
rows x columns grid, save the current shape, delete a saved one. Parity with the webview's layout menu
(`src/webview/components/layout-menu.tsx`).

## Non-goals

- No host or protocol change. `set-layout`, `save-preset` and `delete-preset` already exist, and `PaneLayout.presets`
  already round-trips through `hydrate` and `layout-changed`.
- No `/layout 2x2` argument syntax and no per-shape chords. One dialog is the whole surface.
- No preview thumbnails for presets beyond the grid picker's own ASCII preview.

## Design

### Shared logic (`src/client-core/`)

- `layout-presets.ts` (moved from `src/webview/components/layout-presets.ts`): `BUILTIN_PRESETS` and `shapeMatches`.
  The webview imports from `client-core`, so both clients share one list. The webview file is deleted, not re-exported.
- `layout-apply.ts` (new, pure): `planShape(root, shape, openIds)` wraps `fillShapeKeepingOverflow`, and
  `planGrid(rows, cols, openIds)` wraps `gridLayout`. Both return `{ root, hidden }`, where `hidden` is the open session
  ids that no slot can hold. The webview menu keeps calling the underlying functions; only the TUI uses these wrappers
  unless the move is free.
- Grid dimensions are bounded 1..6, matching the webview's `MAX_DIM`.

### Dialog (`src/tui/ui/layout-dialog.tsx`)

Three sections in the style of `ModeDialog`, one focus ring over their rows:

1. **Grid**: Rows and Columns steppers (left/right adjust), an ASCII preview of the shape filled by the open session
   count, initialised from `gridDims(layout.root)` when the current tree is a grid. Enter on either row applies.
2. **Built-in presets**: `BUILTIN_PRESETS`, the one matching `shapeMatches` against the current root marked.
3. **Saved presets**: `layout.presets`, same marker. `d` on a row posts `delete-preset` and asks no confirmation
   (a preset is a shape, not content).

Keys: up/down move, Enter applies, `s` opens a name prompt (Enter saves via `save-preset`, Esc cancels), Esc closes.
Applying posts `set-layout` with `{ ...layout, root }` and closes.

**Overflow.** If `hidden` is non-empty, Enter does not apply. The dialog shows
`N sessions will be hidden: <titles>` with the row's choice repeated, and a second Enter applies. Esc backs out to
the list. Hidden sessions stay in the roster, as in the webview.

The dialog follows the existing picker contract: `App` holds `picker === 'layout'`, every other key consumer is
inert while it is open (the `dialog || deleting || picker` guards), and Ctrl+C is swallowed like the other dialogs.

### Entry points

- Chord: `Ctrl+W g`, registered in `use-pane-chords.ts` and the keymap, opening the `layout` picker.
- Slash command: `/layout`, added to `parsePickerCommand` in `src/tui/view/pickers.ts`.
- Docs: the chord table and smoke checklist in `docs/tui.md`; the roadmap entry moves to Done.

## Error handling

Errors are state, as everywhere else: a saved preset name that is empty is refused in the prompt (no post); a preset
that no longer exists when Enter is pressed (deleted from another client mid-dialog) simply is not in the list on the
next render because the list is read from state. A foreign-owned session in the tree is treated like any other leaf.

## Testing

- mocha unit: `layout-presets` (every built-in is a valid tree; `shapeMatches` ignores sizes and ids), `layout-apply`
  (hidden computation, 1x1, 6x6, more sessions than slots, fewer sessions than slots).
- bun TUI, through the real `TuiStoreProvider` and `hydrate`: chord and `/layout` open the dialog; applying a built-in posts
  the expected `set-layout`; grid stepper bounds; overflow needs the second Enter and Esc cancels it; `s` saves and
  posts `save-preset`; `d` deletes; other keys are inert while open; active preset marker follows the layout.
- DOM: the existing webview layout-menu tests keep passing against the moved presets module.
- Not verified here: the dialog in a real terminal, and `Ctrl+W g` under tmux or screen (same caveat as the other chords).

## Out of scope, noted

Ctrl+W `g` may be taken by a multiplexer; `/layout` is the fallback, exactly as `/attach` backs up file drop.
