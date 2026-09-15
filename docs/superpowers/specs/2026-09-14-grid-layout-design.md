# Grid layout: nested split tree, drag-to-split, presets, replace-session

## Problem

The pane layout is a flat list plus a single orientation flag
(`PaneLayout { orientation, panes: {sessionId, size}[] }`). It can only ever
produce one row or one column of panes. Users running many monitors want
arbitrary grid arrangements, the ability to drag a pane to split the layout
where they drop it, and a way to jump between a handful of fixed shapes
without rebuilding them by hand.

Separately, closing a derailed session and starting a fresh one in its exact
pane today means two clicks that lose the slot (close, then re-add via
roster/new-session flow, landing wherever the layout reducer happens to put
it). A one-click "replace" on the pane header that keeps the slot is a small,
related win on the same data model.

## Goals

- Any layout achievable by recursively splitting panes horizontally or
  vertically (covers arbitrary grids, not just NxM rectangles).
- Drag a session's header onto another pane's edge to split the layout there,
  VS Code edge convention (top/bottom → row split, left/right → column
  split).
- A catalog of built-in shape presets (2×1, 1×2, 2×2, 3×1, and one asymmetric
  1+2) toggleable from the UI, plus "save current layout as a named preset."
- Empty slots: a placeholder cell with a picker to assign any roster session
  into it, or drag one in.
- One-click "replace" on a pane header: close the session in that pane, spawn
  a new one with the same provider/model/effort/permission-mode/cwd, keep it
  in the same slot.
- Existing on-disk layouts (flat `{orientation, panes}`) migrate without
  resetting anyone's layout.

## Non-goals

- Free-form canvas positioning (arbitrary x/y/w/h). The nested-split tree
  covers every shape this project needs; a free canvas adds resize-cascade
  and invariant-tracking cost for no additional layouts anyone asked for.
- Remembering *which* sessions a saved preset last held. A preset is a shape;
  applying it fills leaves in current pane order, it does not pin identities.
- Auto-fill of a preset's extra slots from the roster. Extra slots stay empty
  per the placeholder-picker behavior above.

## Data model

```ts
type LayoutNode =
  | { kind: 'leaf'; sessionId: SessionId | null; size: number }
  | { kind: 'split'; orientation: 'vertical' | 'horizontal'; children: LayoutNode[]; size: number };

interface PaneLayout {
  root: LayoutNode;
  presets: LayoutPreset[];      // built-in (constants, not persisted) + user-saved (persisted)
  activePresetId?: string;      // set when root structurally matches a saved preset's shape; cleared on any manual edit
}

interface LayoutPreset {
  id: string;
  name: string;
  builtin: boolean;
  root: LayoutNode;             // every leaf's sessionId is null — shape only
}
```

`size` is the existing fractional split-share (0–1 within siblings),
relocated from "per pane in a flat list" to "per node under its parent
split." A `leaf` with `sessionId: null` is an empty slot — the same node
shape used by grid gaps, blocked presets' unfilled cells, and (transiently,
never persisted) a replace-in-flight slot.

A split node is never persisted or rendered with fewer than 2 children — see
Drag-to-split below.

## Rendering

`pane-group.tsx` recurses `LayoutNode`:

- `split` → nested `ResizablePanelGroup` (the vendored `react-resizable-panels`
  wrapper already supports nesting; it just wasn't exercised that way before
  — no new resize primitive needed).
- `leaf` with `sessionId` → existing pane content, unchanged.
- `leaf` with `sessionId: null` → new empty-slot placeholder component:
  empty-state box + a picker (existing session-select affordance) to assign
  any roster session into that leaf. Also the drop target for a dragged
  session.

`onLayoutChanged` (the existing completed-drag, `isUserInteraction`-gated
callback) posts `set-layout` with the full updated tree, same as today but
carrying `root` instead of `{orientation, panes}`.

## Drag-to-split

A drag starts from a grab handle on the session header (new affordance,
visually near the existing close/replace buttons). While a drag from that
handle is active, every leaf renders 4 invisible edge drop-zones overlaid on
its content. Hovering one highlights it per the VS Code convention: top/bottom
→ horizontal split (stacks rows), left/right → vertical split (stacks
columns).

On drop: the target leaf node is replaced with a `split` node of the
indicated orientation, containing `[old leaf, new leaf(draggedSessionId)]`
with equal sizes (0.5/0.5). If the dragged session already occupied a leaf
elsewhere in the tree, that leaf is removed first — and if removing it leaves
its parent split with only one child, that split collapses and is replaced by
its remaining child (standard VS Code editor-group behavior). This collapse
rule is what keeps the "no split node has fewer than 2 children" invariant
true without a separate cleanup pass anywhere else in the codebase.

Dropping onto an empty-slot leaf (rather than a session leaf) assigns the
dragged session into that leaf directly — no split created, since the slot
was already there. This is the same code path the picker's "assign" action
uses.

## Presets

Built-in catalog (`2×1`, `1×2`, `2×2`, `3×1`, `1+2` asymmetric) ships as
constant `LayoutNode` trees, all leaves `sessionId: null`. They are not
persisted — the catalog is code, matching the "which providers exist is a
setting; models are a probe" style split between fixed config and runtime
state elsewhere in this codebase.

**Applying a preset:** walk the preset's leaves in tree order (depth-first,
matching visual left-to-right/top-to-bottom reading order); fill them with
the currently-visible sessions in their current pane order. If there are more
visible sessions than slots, the switch is **blocked** — the preset control
is disabled with a reason (matching count needed), and no partial layout is
ever posted; this is computed before any mutation, so a blocked preset never
touches `state.layout`. If there are fewer sessions than slots, the leftover
slots render as empty placeholders per the Rendering section.

**Saving a preset:** strips every `sessionId` from the live root
(structure-only copy), asks for a name, appends to `presets` with
`builtin: false`. Persisted in the same host-side index file `paneLayout`
already lives in. Re-applying a saved preset later follows the same
fill-by-current-order rule as a built-in one — a preset is a shape, not a
remembered set of session identities.

## Replace-session

New pane-header button next to the existing close control. New
`WebviewToHost` message:

```ts
{ t: 'replace-session'; sessionId: SessionId }
```

`SessionManager.replaceSession(sessionId)`:

1. Snapshot the target session's `{provider, model, effort, permissionMode, cwd}`.
2. **Create** a new session with that config first (existing create path).
3. Only once creation succeeds: close the old session (existing close
   semantics — same archive/delete behavior a manual close gets today), and
   mutate the layout leaf that held the old `sessionId` to point at the new
   one, in place. No tree reshape, no resize, no reindex.
4. If creation fails, the old session and its leaf are untouched — matches
   "errors are state" (the failure surfaces however a normal create failure
   does today; nothing about the layout is touched on a failed replace).

Fan-out is the existing `sessions-changed` + `layout-changed` pair, no new
message type needed for the roster/transcript side.

## Migration

`transcript-store.ts`'s index loader wraps a legacy flat layout on first
read:

```ts
{ root: { kind: 'split', orientation: legacy.orientation,
          children: legacy.panes.map(p => ({ kind: 'leaf', sessionId: p.sessionId, size: p.size })) },
  presets: [] }
```

Applied once, at load; the on-disk shape is rewritten in the new form the
next time the index is saved through the existing write paths. No dedicated
migration script or version flag — the loader simply recognizes the old
shape (absence of `root`) and upgrades it.

## Testing

- **Unit (`yarn test:unit`):** pure tree-mutation functions — split-insert,
  remove-leaf-and-collapse, fill-preset-from-panes, preset-overflow-check —
  get direct mocha tests, no DOM, same style `pane-layout.ts` uses today.
- **DOM (`yarn test:dom`):** drag-to-split (drop on each of the 4 edges of a
  leaf, and on an empty-slot leaf), preset apply (fits / blocked-overflow /
  leftover-empty), save-as-preset, and the replace-session button — all
  driven through the real `StoreProvider` via `sendFromHost`, asserting on
  posted messages per the existing DOM-test convention.

## Open items for the implementation plan

None outstanding — every question raised during design has an answered
decision recorded above.
