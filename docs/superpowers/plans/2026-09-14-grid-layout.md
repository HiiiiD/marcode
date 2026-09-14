# Grid Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat one-row/one-column `PaneLayout` with a nested binary
split tree, add drag-to-split, built-in + saved grid presets, empty-slot
assignment, and a one-click "replace session" action on the pane header.

**Architecture:** `PaneLayout.root` becomes a `LayoutNode` tree (`leaf` |
`split`), mirroring VS Code's own editor-group model. A new dependency-free
`layout-tree.ts` module holds every pure tree mutation (split, remove+collapse,
assign, fill-from-preset, strip-to-shape); `pane-layout.ts` keeps the
roster/reconcile logic but rebuilds it on top of that tree. `pane-group.tsx`'s
flat `.map()` becomes a small recursive `layout-node-view.tsx`. Drag-to-split
uses native HTML5 DnD (matching the existing pattern in `composer.tsx`), no
new dependency. Presets: built-ins are code constants (never persisted, never
round-tripped through the host); user-saved presets live in `PaneLayout.presets`,
persisted the same way `paneLayout` already is. Replace-session is a new
host message that creates before it closes, then swaps one leaf's `sessionId`
in place.

**Tech Stack:** TypeScript, React 19, `react-resizable-panels` (already
vendored via `src/webview/components/ui/resizable.tsx`), native HTML5 DnD,
mocha (`test:unit`), mocha+jsdom+testing-library (`test:dom`).

**Spec:** [docs/superpowers/specs/2026-09-14-grid-layout-design.md](../specs/2026-09-14-grid-layout-design.md)

## Global Constraints

- Filenames kebab-case; component identifiers PascalCase.
- No raw HTML controls in feature code — `Button`, `DropdownMenu`, etc. from
  `@/components/ui/*` only. Vendor anything missing rather than hand-roll it.
- `src/protocol/messages.ts` stays types-only — no runtime code, no `vscode`
  import.
- Nothing under `src/providers/`, `src/protocol/`, or `src/host/message-router.ts`
  imports `vscode`.
- Every protocol message addressed to a session carries an explicit
  `SessionId`. No implicit "current session."
- Errors are state, never exceptions — a failed replace-session leaves the
  old session and its leaf untouched, never an unhandled rejection.
- `cn` from `@/lib/utils` for every conditional className; never template
  literals.
- `yarn lint`, `yarn check-types`, `yarn run compile` must pass before every
  commit. Run `yarn test:unit` / `yarn test:dom` (guarded, not the `:raw`
  variants) after touching their respective layers.
- Any file under `src/webview/components/` touched in a task gets
  `node <impeccable-skill-dir>/scripts/detect.mjs --json <files>` run over it
  before that task's commit — exit 0 required.
- Conventional-commit prefixes (`feat:`, `fix:`, `test:`, `chore:`, `docs:`).
  Commit after every task.
- This is on branch `feat/grid-layout`. Do not push unless asked.

**Note on scope:** `PaneLayout`'s type change ripples into every existing
test that builds a layout fixture by hand (`src/test/fixtures/protocol.ts`'s
`layoutOf` helper, `pane-group.test.tsx`, `pane-layout.test.ts`, and any
`session-picker`/`session-header` test touching `state.layout`). Task 1
updates the shared fixture helper; every later task that touches a consuming
file updates that file's own now-broken assertions as part of its own steps
— this is called out explicitly in each task rather than deferred to a
sweep-up task, so nothing is left half-migrated.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/protocol/messages.ts` | *(modify)* `LayoutNode`, new `PaneLayout`, `LayoutPreset`; `replace-session`, `save-preset`, `delete-preset` messages |
| `src/webview/components/layout-tree.ts` | *(new)* Pure tree primitives — split, remove+collapse, assign, fill-from-shape, strip-to-shape. Dependency-free, unit-tested directly. |
| `src/webview/components/layout-presets.ts` | *(new)* Built-in preset constants + `shapeMatches` (active-preset detection). Dependency-free. |
| `src/webview/components/pane-layout.ts` | *(modify)* Roster/reconcile logic rebuilt on `layout-tree.ts` |
| `src/test/fixtures/protocol.ts` | *(modify)* `layoutOf` and related fixture helpers rebuilt for the tree shape |
| `src/host/transcript-store.ts` | *(modify)* `StoredIndex.layout` migration from legacy flat shape |
| `src/host/session-manager.ts` | *(modify)* `paneLayout` type, `remove()`'s layout mutation, new `replaceSession()`, `savePreset()`, `deletePreset()` |
| `src/host/message-router.ts` | *(modify)* wire `replace-session`, `save-preset`, `delete-preset`; update `isWireMessage` |
| `src/webview/reducer.ts` | *(modify)* default layout value only — `local-layout`/`layout-changed` cases are already generic |
| `src/webview/components/layout-node-view.tsx` | *(new)* Recursive `LayoutNode` renderer — leaf/split/empty-slot, replaces `pane-group.tsx`'s flat `.map()` |
| `src/webview/components/pane-group.tsx` | *(modify)* Delegates rendering to `layout-node-view.tsx`; keeps the empty-roster state |
| `src/webview/components/empty-slot.tsx` | *(new)* Empty-leaf placeholder + assign-picker |
| `src/webview/components/pane-drag-context.tsx` | *(new)* Tiny React context carrying "which sessionId is being dragged," so drop targets don't need `dataTransfer.getData` (jsdom's DataTransfer read support is inconsistent) |
| `src/webview/components/session-header.tsx` | *(modify)* Drag handle + replace-session button |
| `src/webview/components/session-picker.tsx` | *(modify)* Orientation toggle guarded to split roots; presets menu added |
| `src/webview/components/layout-presets-menu.tsx` | *(new)* Preset picker dropdown + save/delete UI |
| `src/test/unit/layout-tree.test.ts` | *(new)* Unit tests for the pure tree module |
| `src/test/unit/pane-layout.test.ts` | *(modify)* Rebuilt for tree shape |
| `src/test/unit/transcript-store.test.ts` | *(modify)* Migration test added (create if it doesn't exist yet — check first) |
| `src/test/unit/session-manager.test.ts` | *(modify)* `replaceSession`/`savePreset`/`deletePreset` tests (check exact existing filename first) |
| `src/test/dom/pane-group.test.tsx` | *(modify)* Rebuilt for tree rendering, drag-to-split, empty slots |
| `src/test/dom/session-header.test.tsx` | *(modify)* Replace-session button test (check exact existing filename first) |
| `src/test/dom/layout-presets.test.tsx` | *(new)* Preset apply/save/delete DOM tests |

---

### Task 1: Protocol types — `LayoutNode`, `PaneLayout`, `LayoutPreset`, new messages

**Files:**
- Modify: `src/protocol/messages.ts:409-412` (replace `PaneLayout`), `:414-660` (`WebviewToHost`)
- Modify: `src/test/fixtures/protocol.ts` (rebuild `layoutOf` and any other layout fixture helper)
- Test: `src/test/unit/protocol-fixtures.test.ts` *(new — a tiny smoke test that the fixture helper produces a structurally valid tree; skip if no existing precedent for testing fixtures directly, in which case fold this check into Task 2's tests instead)*

**Interfaces:**
- Produces: `LayoutNode` (`{kind:'leaf', sessionId: SessionId | null, size: number} | {kind:'split', orientation: 'vertical'|'horizontal', children: LayoutNode[], size: number}`), `PaneLayout` (`{root: LayoutNode, presets: LayoutPreset[]}`), `LayoutPreset` (`{id: string, name: string, builtin: boolean, root: LayoutNode}`), new `WebviewToHost` variants `{t:'replace-session', id: SessionId}`, `{t:'save-preset', name: string}`, `{t:'delete-preset', id: string}`.

- [ ] **Step 1: Replace `PaneLayout` and add `LayoutNode`/`LayoutPreset`**

Replace `src/protocol/messages.ts:409-412`:

```ts
export type LayoutNode =
  | { kind: 'leaf'; sessionId: SessionId | null; size: number }
  | { kind: 'split'; orientation: 'vertical' | 'horizontal'; children: LayoutNode[]; size: number };

export interface LayoutPreset {
  id: string;
  name: string;
  builtin: boolean;
  root: LayoutNode;
}

export interface PaneLayout {
  root: LayoutNode;
  /** User-saved presets only — built-ins are code constants, never sent over the wire. */
  presets: LayoutPreset[];
}
```

- [ ] **Step 2: Add the three new `WebviewToHost` variants**

In the `WebviewToHost` union (near the existing `'close-session'`/`'delete-session'` entries, `src/protocol/messages.ts:414-660`), add:

```ts
  | { t: 'replace-session'; id: SessionId }
  | { t: 'save-preset'; name: string }
  | { t: 'delete-preset'; id: string }
```

- [ ] **Step 3: Rebuild `layoutOf` in the fixture helper**

Read `src/test/fixtures/protocol.ts` first to find the exact current `layoutOf` signature and every other export in that file, then replace it. It must keep being the single place every test builds a `PaneLayout` from a plain list of session ids, so callers across the suite don't need touching individually for the common case:

```ts
import type { LayoutNode, PaneLayout, SessionId } from '../../protocol/messages';

/** A flat row (vertical) or column (horizontal) of the given session ids — the shape most existing tests want. */
export function layoutOf(sessionIds: SessionId[], orientation: 'vertical' | 'horizontal' = 'vertical'): PaneLayout {
  const size = sessionIds.length > 0 ? 100 / sessionIds.length : 100;
  const root: LayoutNode = sessionIds.length === 0
    ? { kind: 'leaf', sessionId: null, size: 100 }
    : { kind: 'split', orientation, children: sessionIds.map((sessionId) => ({ kind: 'leaf' as const, sessionId, size })), size: 100 };
  return { root, presets: [] };
}

/** A single-pane layout — shorthand used by tests that don't care about orientation. */
export function singlePaneLayout(sessionId: SessionId): PaneLayout {
  return { root: { kind: 'leaf', sessionId, size: 100 }, presets: [] };
}
```

- [ ] **Step 4: `yarn check-types`**

Expected: fails across many files that still reference `layout.orientation`/`layout.panes` — that's expected; this task only establishes the new types. Confirm the failures are all in files this plan's later tasks own (not some unrelated surface) by skimming the error list.

- [ ] **Step 5: Commit**

```bash
git add src/protocol/messages.ts src/test/fixtures/protocol.ts
git commit -m "feat: add LayoutNode tree type and replace-session/preset messages"
```

---

### Task 2: `layout-tree.ts` — pure tree primitives

**Files:**
- Create: `src/webview/components/layout-tree.ts`
- Test: `src/test/unit/layout-tree.test.ts`

**Interfaces:**
- Consumes: nothing (dependency-free, mirrors `LayoutNode` structurally rather than importing it — same convention `pane-layout.ts` already uses for `PaneLayout`, see its file-header comment).
- Produces: `LayoutNodeLike`, `emptyRoot()`, `flattenLeaves(root)`, `leafSessionIds(root)`, `findPath(root, sessionId)`, `slotCount(root)`, `splitAt(root, path, orientation, newSessionId)`, `assignAt(root, path, sessionId)`, `removeSession(root, sessionId)`, `replaceLeafSession(root, oldId, newId)`, `fillShape(shape, sessionIds)`, `stripSessionIds(root)`.

- [ ] **Step 1: Write the failing tests for the read-only helpers**

```ts
// src/test/unit/layout-tree.test.ts
import * as assert from 'assert';
import {
  emptyRoot, flattenLeaves, leafSessionIds, findPath, slotCount,
} from '../../webview/components/layout-tree';

suite('layout-tree read helpers', () => {
  test('emptyRoot is a single null leaf', () => {
    assert.deepStrictEqual(emptyRoot(), { kind: 'leaf', sessionId: null, size: 100 });
  });

  test('flattenLeaves walks depth-first, recording each leaf\'s path', () => {
    const root = {
      kind: 'split' as const, orientation: 'horizontal' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        {
          kind: 'split' as const, orientation: 'vertical' as const, size: 50,
          children: [
            { kind: 'leaf' as const, sessionId: 'b', size: 50 },
            { kind: 'leaf' as const, sessionId: null, size: 50 },
          ],
        },
      ],
    };
    assert.deepStrictEqual(flattenLeaves(root), [
      { sessionId: 'a', path: [0], size: 50 },
      { sessionId: 'b', path: [1, 0], size: 50 },
      { sessionId: null, path: [1, 1], size: 50 },
    ]);
  });

  test('leafSessionIds skips empty leaves', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: null, size: 50 },
      ],
    };
    assert.deepStrictEqual(leafSessionIds(root), ['a']);
  });

  test('findPath locates a session, returns undefined when absent', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: 'b', size: 50 },
      ],
    };
    assert.deepStrictEqual(findPath(root, 'b'), [1]);
    assert.strictEqual(findPath(root, 'z'), undefined);
  });

  test('slotCount counts every leaf, empty or not', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: null, size: 50 },
      ],
    };
    assert.strictEqual(slotCount(root), 2);
  });
});
```

- [ ] **Step 2: Run, confirm it fails on missing module**

Run: `yarn test:unit --grep "layout-tree read helpers"`
Expected: FAIL — `Cannot find module '../../webview/components/layout-tree'`

- [ ] **Step 3: Implement the read-only helpers**

```ts
// src/webview/components/layout-tree.ts
// Pure LayoutNode tree logic, kept dependency-free (no React, no `@/...`
// imports) so it can be required directly in the Node/mocha unit-test
// harness — same constraint and convention as pane-layout.ts. Shapes mirror
// `LayoutNode` from `protocol/messages.ts` structurally rather than
// importing it.

export type LayoutNode =
  | { kind: 'leaf'; sessionId: string | null; size: number }
  | { kind: 'split'; orientation: 'vertical' | 'horizontal'; children: LayoutNode[]; size: number };

export function emptyRoot(): LayoutNode {
  return { kind: 'leaf', sessionId: null, size: 100 };
}

export interface FlatLeaf {
  sessionId: string | null;
  path: number[];
  size: number;
}

/** Depth-first walk of every leaf, empty or not, each tagged with the child-index path to reach it. */
export function flattenLeaves(node: LayoutNode, path: number[] = []): FlatLeaf[] {
  if (node.kind === 'leaf') { return [{ sessionId: node.sessionId, path, size: node.size }]; }
  return node.children.flatMap((child, i) => flattenLeaves(child, [...path, i]));
}

export function leafSessionIds(node: LayoutNode): string[] {
  return flattenLeaves(node)
    .map((l) => l.sessionId)
    .filter((id): id is string => id !== null);
}

export function findPath(node: LayoutNode, sessionId: string): number[] | undefined {
  return flattenLeaves(node).find((l) => l.sessionId === sessionId)?.path;
}

export function slotCount(node: LayoutNode): number {
  return flattenLeaves(node).length;
}
```

- [ ] **Step 4: Run, confirm the read-only tests pass**

Run: `yarn test:unit --grep "layout-tree read helpers"`
Expected: PASS

- [ ] **Step 5: Write the failing tests for the mutating helpers**

```ts
// append to src/test/unit/layout-tree.test.ts
import {
  splitAt, assignAt, removeSession, replaceLeafSession, fillShape, stripSessionIds,
} from '../../webview/components/layout-tree';

suite('layout-tree splitAt', () => {
  test('replaces the leaf at path with a 50/50 split of the two sessions', () => {
    const root = { kind: 'leaf' as const, sessionId: 'a', size: 100 };
    const next = splitAt(root, [], 'horizontal', 'b');
    assert.deepStrictEqual(next, {
      kind: 'split', orientation: 'horizontal', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: 'b', size: 50 },
      ],
    });
  });

  test('splits a leaf nested inside an existing split', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: 'b', size: 50 },
      ],
    };
    const next = splitAt(root, [1], 'horizontal', 'c');
    assert.deepStrictEqual(next, {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        {
          kind: 'split', orientation: 'horizontal', size: 50,
          children: [
            { kind: 'leaf', sessionId: 'b', size: 50 },
            { kind: 'leaf', sessionId: 'c', size: 50 },
          ],
        },
      ],
    });
  });
});

suite('layout-tree assignAt', () => {
  test('sets an empty leaf\'s sessionId in place, no structural change', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: null, size: 50 },
      ],
    };
    const next = assignAt(root, [1], 'b');
    assert.deepStrictEqual(next, {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: 'b', size: 50 },
      ],
    });
  });
});

suite('layout-tree removeSession', () => {
  test('a leaf at the tree root becomes an empty leaf', () => {
    const root = { kind: 'leaf' as const, sessionId: 'a', size: 100 };
    assert.deepStrictEqual(removeSession(root, 'a'), { kind: 'leaf', sessionId: null, size: 100 });
  });

  test('removing one of two siblings collapses the split to the survivor', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 30 },
        { kind: 'leaf' as const, sessionId: 'b', size: 70 },
      ],
    };
    // Collapse takes the survivor's role in the grandparent, sized 100 —
    // matches the old evenlySizedPanes behavior of never preserving a
    // departing sibling's proportions.
    assert.deepStrictEqual(removeSession(root, 'a'), { kind: 'leaf', sessionId: 'b', size: 100 });
  });

  test('removing one of three siblings reflows the remaining two evenly, no collapse', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 20 },
        { kind: 'leaf' as const, sessionId: 'b', size: 30 },
        { kind: 'leaf' as const, sessionId: 'c', size: 50 },
      ],
    };
    assert.deepStrictEqual(removeSession(root, 'a'), {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'b', size: 50 },
        { kind: 'leaf', sessionId: 'c', size: 50 },
      ],
    });
  });

  test('collapsing a nested split preserves the survivor at its grandparent slot, sized by the grandparent', () => {
    const root = {
      kind: 'split' as const, orientation: 'horizontal' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        {
          kind: 'split' as const, orientation: 'vertical' as const, size: 50,
          children: [
            { kind: 'leaf' as const, sessionId: 'b', size: 60 },
            { kind: 'leaf' as const, sessionId: 'c', size: 40 },
          ],
        },
      ],
    };
    assert.deepStrictEqual(removeSession(root, 'b'), {
      kind: 'split', orientation: 'horizontal', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: 'c', size: 50 },
      ],
    });
  });

  test('removing a session not present is a no-op', () => {
    const root = { kind: 'leaf' as const, sessionId: 'a', size: 100 };
    assert.deepStrictEqual(removeSession(root, 'z'), root);
  });
});

suite('layout-tree replaceLeafSession', () => {
  test('swaps one leaf\'s sessionId, no structural change', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 40 },
        { kind: 'leaf' as const, sessionId: 'b', size: 60 },
      ],
    };
    assert.deepStrictEqual(replaceLeafSession(root, 'a', 'z'), {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'z', size: 40 },
        { kind: 'leaf', sessionId: 'b', size: 60 },
      ],
    });
  });
});

suite('layout-tree fillShape', () => {
  test('fills leaves depth-first with the given ids, extras left empty', () => {
    const shape = {
      kind: 'split' as const, orientation: 'horizontal' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: null, size: 50 },
        { kind: 'leaf' as const, sessionId: null, size: 50 },
      ],
    };
    assert.deepStrictEqual(fillShape(shape, ['a']), {
      kind: 'split', orientation: 'horizontal', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: null, size: 50 },
      ],
    });
  });

  test('returns undefined when there are more sessions than slots', () => {
    const shape = { kind: 'leaf' as const, sessionId: null, size: 100 };
    assert.strictEqual(fillShape(shape, ['a', 'b']), undefined);
  });
});

suite('layout-tree stripSessionIds', () => {
  test('produces the same shape with every leaf emptied', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: 'b', size: 50 },
      ],
    };
    assert.deepStrictEqual(stripSessionIds(root), {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: null, size: 50 },
        { kind: 'leaf', sessionId: null, size: 50 },
      ],
    });
  });
});
```

- [ ] **Step 6: Run, confirm the new suites fail**

Run: `yarn test:unit --grep "layout-tree"`
Expected: FAIL — the mutating functions don't exist yet.

- [ ] **Step 7: Implement the mutating helpers**

Append to `src/webview/components/layout-tree.ts`:

```ts
function at(node: LayoutNode, path: number[]): LayoutNode {
  let cur = node;
  for (const i of path) {
    if (cur.kind !== 'split') { throw new Error('layout-tree: path runs through a leaf'); }
    cur = cur.children[i];
  }
  return cur;
}

/** Immutable replace of the node at `path`, keeping every sibling's `size` untouched. */
function replaceAt(node: LayoutNode, path: number[], next: LayoutNode): LayoutNode {
  if (path.length === 0) { return next; }
  if (node.kind !== 'split') { throw new Error('layout-tree: path runs through a leaf'); }
  const [head, ...rest] = path;
  return {
    ...node,
    children: node.children.map((child, i) => (i === head ? replaceAt(child, rest, next) : child)),
  };
}

function evenSizes(count: number): number[] {
  return count > 0 ? Array(count).fill(100 / count) : [];
}

/** Splits the leaf at `path` into a 2-child split of [existing leaf, new leaf(newSessionId)], 50/50. */
export function splitAt(
  root: LayoutNode, path: number[], orientation: 'vertical' | 'horizontal', newSessionId: string,
): LayoutNode {
  const target = at(root, path);
  if (target.kind !== 'split' && target.kind !== 'leaf') { throw new Error('unreachable'); }
  const size = target.size;
  const next: LayoutNode = {
    kind: 'split', orientation, size,
    children: [{ ...target, size: 50 }, { kind: 'leaf', sessionId: newSessionId, size: 50 }],
  };
  return replaceAt(root, path, next);
}

/** Sets the sessionId of the (empty) leaf at `path`. Throws if that leaf already holds a session — callers check via `flattenLeaves` first. */
export function assignAt(root: LayoutNode, path: number[], sessionId: string): LayoutNode {
  const target = at(root, path);
  if (target.kind !== 'leaf') { throw new Error('layout-tree: assignAt target is not a leaf'); }
  if (target.sessionId !== null) { throw new Error('layout-tree: assignAt target is not empty'); }
  return replaceAt(root, path, { ...target, sessionId });
}

/**
 * Removes a session from the tree. At the tree root, the leaf just goes
 * empty (there's nothing to collapse into). Nested under a split with only
 * one other sibling, the split collapses and the survivor takes the split's
 * own slot and size — the same "no split node has fewer than 2 children"
 * invariant the design doc's drag-to-split section describes, reused here
 * for the Hide button and roster-uncheck, both of which are really the same
 * "this session no longer has a pane" operation drag-move already needs.
 * With three or more siblings, the split survives and its remaining
 * children reflow evenly — matches the flat model's old
 * `evenlySizedPanes(remaining, orientation)`, which never preserved a
 * departing sibling's proportions either.
 */
export function removeSession(root: LayoutNode, sessionId: string): LayoutNode {
  const path = findPath(root, sessionId);
  if (path === undefined) { return root; }
  if (path.length === 0) { return { kind: 'leaf', sessionId: null, size: root.size }; }

  const parentPath = path.slice(0, -1);
  const childIndex = path[path.length - 1];
  const parent = at(root, parentPath);
  if (parent.kind !== 'split') { throw new Error('unreachable'); }

  const remaining = parent.children.filter((_, i) => i !== childIndex);
  if (remaining.length === 1) {
    return replaceAt(root, parentPath, { ...remaining[0], size: parent.size });
  }
  const sizes = evenSizes(remaining.length);
  return replaceAt(root, parentPath, {
    ...parent,
    children: remaining.map((child, i) => ({ ...child, size: sizes[i] })),
  });
}

/** In-place leaf sessionId swap — used by replace-session. No structural change, no reflow. */
export function replaceLeafSession(root: LayoutNode, oldSessionId: string, newSessionId: string): LayoutNode {
  const path = findPath(root, oldSessionId);
  if (path === undefined) { return root; }
  const target = at(root, path);
  if (target.kind !== 'leaf') { throw new Error('unreachable'); }
  return replaceAt(root, path, { ...target, sessionId: newSessionId });
}

/**
 * Fills a shape's leaves depth-first with `sessionIds`, in order. Extra
 * slots stay empty. Returns `undefined` — never a partial tree — when there
 * are more sessions than slots, so a caller can check-before-mutate and
 * never posts a half-applied preset.
 */
export function fillShape(shape: LayoutNode, sessionIds: string[]): LayoutNode | undefined {
  if (sessionIds.length > slotCount(shape)) { return undefined; }
  let i = 0;
  const fill = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'leaf') {
      return i < sessionIds.length ? { ...node, sessionId: sessionIds[i++] } : node;
    }
    return { ...node, children: node.children.map(fill) };
  };
  return fill(shape);
}

/** Same shape, every leaf's sessionId cleared — used when saving the current layout as a named preset. */
export function stripSessionIds(node: LayoutNode): LayoutNode {
  if (node.kind === 'leaf') { return { ...node, sessionId: null }; }
  return { ...node, children: node.children.map(stripSessionIds) };
}
```

- [ ] **Step 8: Run, confirm all `layout-tree` tests pass**

Run: `yarn test:unit --grep "layout-tree"`
Expected: PASS

- [ ] **Step 9: Lint, types, commit**

```bash
yarn lint && yarn check-types
git add src/webview/components/layout-tree.ts src/test/unit/layout-tree.test.ts
git commit -m "feat: pure LayoutNode tree mutation primitives"
```

---

### Task 3: `pane-layout.ts` rebuilt on the tree; existing unit tests migrated

**Files:**
- Modify: `src/webview/components/pane-layout.ts` (full rewrite of `visiblePanes`/`reconcilePaneLayout`; `rosterSessionIds`/`accessibleTitles` keep their signatures)
- Modify: `src/test/unit/pane-layout.test.ts` (full rewrite for tree fixtures)

**Interfaces:**
- Consumes: `LayoutNode`, `flattenLeaves`, `leafSessionIds`, `removeSession` from `./layout-tree`.
- Produces: `rosterSessionIds(sessions)` *(unchanged signature)*, `leafDisplayState(sessionId, roster, snapshotArrived): 'empty' | 'pending' | 'ready'`, `visibleLeaves(root, roster, snapshotArrived): (FlatLeaf & {state: 'empty'|'pending'|'ready'})[]`, `reconcilePaneLayout(root, roster, snapshotArrivedIds, knownSessionIds): {root: LayoutNode | null, knownSessionIds: Set<string>}`, `accessibleTitles(sessions)` *(unchanged)*.

- [ ] **Step 1: Read the current file in full**

Read `src/webview/components/pane-layout.ts` (already reproduced in the design/exploration above — 194 lines) so the doc comments explaining *why* each invariant exists carry over rather than getting silently dropped.

- [ ] **Step 2: Write the failing tests**

```ts
// src/test/unit/pane-layout.test.ts — full rewrite
import * as assert from 'assert';
import {
  accessibleTitles, leafDisplayState, reconcilePaneLayout, rosterSessionIds, visibleLeaves,
} from '../../webview/components/pane-layout';
import type { LayoutNode } from '../../webview/components/layout-tree';

suite('pane-layout rosterSessionIds', () => {
  test('every session id, archived or not', () => {
    const ids = rosterSessionIds([{ id: 'a', archived: false }, { id: 'b', archived: true }]);
    assert.deepStrictEqual([...ids], ['a', 'b']);
  });
});

suite('pane-layout leafDisplayState', () => {
  const roster = new Set(['a']);
  const arrived = new Set(['a']);
  test('null sessionId is empty', () => {
    assert.strictEqual(leafDisplayState(null, roster, arrived), 'empty');
  });
  test('a session not yet in the roster/byId is pending', () => {
    assert.strictEqual(leafDisplayState('z', roster, arrived), 'pending');
  });
  test('a session in both roster and byId is ready', () => {
    assert.strictEqual(leafDisplayState('a', roster, arrived), 'ready');
  });
});

suite('pane-layout visibleLeaves', () => {
  test('tags each leaf with its display state, path preserved', () => {
    const root: LayoutNode = {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: null, size: 50 },
      ],
    };
    const result = visibleLeaves(root, new Set(['a']), new Set(['a']));
    assert.deepStrictEqual(result, [
      { sessionId: 'a', path: [0], size: 50, state: 'ready' },
      { sessionId: null, path: [1], size: 50, state: 'empty' },
    ]);
  });
});

suite('pane-layout reconcilePaneLayout', () => {
  test('drops a leaf whose session left the roster outright, collapsing its split', () => {
    const root: LayoutNode = {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: 'b', size: 50 },
      ],
    };
    const result = reconcilePaneLayout(root, new Set(['a']), ['a'], new Set(['a']));
    assert.deepStrictEqual(result.root, { kind: 'leaf', sessionId: 'a', size: 100 });
  });

  test('appends a newly-arrived session as a sibling at the top split level', () => {
    const root: LayoutNode = { kind: 'leaf', sessionId: 'a', size: 100 };
    const result = reconcilePaneLayout(root, new Set(['a', 'b']), ['a', 'b'], new Set(['a']));
    assert.deepStrictEqual(result.root, {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: 'b', size: 50 },
      ],
    });
  });

  test('a session the user explicitly unchecked never comes back once known', () => {
    const root: LayoutNode = { kind: 'leaf', sessionId: null, size: 100 };
    const result = reconcilePaneLayout(root, new Set(['a']), ['a'], new Set(['a']));
    assert.strictEqual(result.root, null);
  });

  test('returns null when nothing needs to change', () => {
    const root: LayoutNode = { kind: 'leaf', sessionId: 'a', size: 100 };
    const result = reconcilePaneLayout(root, new Set(['a']), ['a'], new Set(['a']));
    assert.strictEqual(result.root, null);
  });
});

suite('pane-layout accessibleTitles', () => {
  test('disambiguates a title collision with the id, leaves uniques alone', () => {
    const names = accessibleTitles([{ id: '1', title: 'Untitled' }, { id: '2', title: 'Untitled' }, { id: '3', title: 'fix bug' }]);
    assert.strictEqual(names.get('1'), 'Untitled (1)');
    assert.strictEqual(names.get('3'), 'fix bug');
  });
});
```

- [ ] **Step 3: Run, confirm it fails to compile / fails**

Run: `yarn test:unit --grep "pane-layout"`
Expected: FAIL — `leafDisplayState`/`visibleLeaves` don't exist; `reconcilePaneLayout`'s signature has changed.

- [ ] **Step 4: Rewrite `pane-layout.ts`**

```ts
// src/webview/components/pane-layout.ts — full rewrite
// Pure roster/reconciliation logic over a LayoutNode tree, kept
// dependency-free for the same reason layout-tree.ts is: direct
// requirability from the Node/mocha unit-test harness.

import { findPath, flattenLeaves, leafSessionIds, removeSession, type FlatLeaf, type LayoutNode } from './layout-tree';

export interface RosterEntry {
  id: string;
  archived: boolean;
}

/**
 * The set of session ids eligible to have a leaf, derived from the roster.
 * Deliberately does NOT filter out `archived: true` — see the doc comment
 * this carries over from the pre-tree version: only `delete-session` removes
 * a session from the roster entirely, and an archived session the user has
 * explicitly opened must keep its leaf.
 */
export function rosterSessionIds(sessions: RosterEntry[]): Set<string> {
  return new Set(sessions.map((s) => s.id));
}

export type LeafDisplayState = 'empty' | 'pending' | 'ready';

/**
 * `empty`: no session assigned (an assignable slot).
 * `pending`: a session is assigned but hasn't cleared the roster/snapshot
 * gate yet — either its snapshot hasn't arrived (`byId`) or, transiently, it
 * has already left the roster and a `reconcilePaneLayout` pass just hasn't
 * caught up. Rendered as an inert placeholder, never the assign-picker: a
 * picker here would let a user "assign" a session the tree already points
 * at.
 * `ready`: render the real pane.
 */
export function leafDisplayState(
  sessionId: string | null, roster: ReadonlySet<string>, snapshotArrived: ReadonlySet<string>,
): LeafDisplayState {
  if (sessionId === null) { return 'empty'; }
  return roster.has(sessionId) && snapshotArrived.has(sessionId) ? 'ready' : 'pending';
}

export type DisplayLeaf = FlatLeaf & { state: LeafDisplayState };

/** Every leaf in the tree, tagged with how it should render — this never mutates the tree itself; a `pending`/dropped leaf is corrected by `reconcilePaneLayout`, not by hiding it here. */
export function visibleLeaves(
  root: LayoutNode, roster: ReadonlySet<string>, snapshotArrived: ReadonlySet<string>,
): DisplayLeaf[] {
  return flattenLeaves(root).map((leaf) => ({ ...leaf, state: leafDisplayState(leaf.sessionId, roster, snapshotArrived) }));
}

export interface ReconcileResult {
  /** The next tree to persist, or `null` if nothing needs to change. */
  root: LayoutNode | null;
  knownSessionIds: Set<string>;
}

/**
 * Reconciles a persisted tree against the current roster. Ports the
 * pre-tree invariants 1:1 (see the flat version's doc comment for the full
 * "why", unchanged by the tree): the tree IS the user's intent, session
 * *state* never decides whether a session should have a leaf, and only two
 * things ever happen automatically —
 *  - a leaf whose session left the roster outright is removed (via
 *    `removeSession`, which also collapses its parent split);
 *  - a session whose snapshot has arrived in `byId` for the FIRST time gets
 *    appended as a new sibling leaf at the top split level (wrapping a bare
 *    leaf root into a 2-child vertical split if needed) — this is what
 *    opens a freshly created session into a pane. A session already in
 *    `knownSessionIds` is never re-appended, even if the user just removed
 *    its leaf.
 *
 * The same `knownSessionIds`-reset-on-reload safety the flat version relied
 * on still holds: `byId` after a reload is seeded solely from
 * `hydrate.snapshots`, which the host builds from the persisted tree's own
 * leaves, not the whole roster — see `message-router.ts`'s `ready` handler.
 */
export function reconcilePaneLayout(
  root: LayoutNode, roster: ReadonlySet<string>, snapshotArrivedIds: string[], knownSessionIds: ReadonlySet<string>,
): ReconcileResult {
  let next = root;
  let changed = false;
  for (const id of leafSessionIds(root)) {
    if (!roster.has(id)) { next = removeSession(next, id); changed = true; }
  }

  const stillPresent = new Set(leafSessionIds(next));
  const newlyArrived = snapshotArrivedIds.filter(
    (id) => roster.has(id) && !stillPresent.has(id) && !knownSessionIds.has(id),
  );
  for (const id of newlyArrived) {
    changed = true;
    next = next.kind === 'leaf' && next.sessionId === null
      ? { kind: 'leaf', sessionId: id, size: 100 }
      : {
        kind: 'split', orientation: 'vertical', size: 100,
        children: [...(next.kind === 'split' && next.orientation === 'vertical' ? next.children : [next]), { kind: 'leaf', sessionId: id, size: 0 }]
          .map((child, i, arr) => ({ ...child, size: 100 / arr.length })),
      };
  }

  const nextKnown = new Set(knownSessionIds);
  for (const id of snapshotArrivedIds) { nextKnown.add(id); }

  return { root: changed ? next : null, knownSessionIds: nextKnown };
}

export interface TitledSession {
  id: string;
  title: string;
}

/** Unchanged from the pre-tree version — operates on a flat list of (id, title), not on layout shape. */
export function accessibleTitles(sessions: TitledSession[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const s of sessions) { counts.set(s.title, (counts.get(s.title) ?? 0) + 1); }
  const result = new Map<string, string>();
  for (const s of sessions) {
    result.set(s.id, (counts.get(s.title) ?? 0) > 1 ? `${s.title} (${s.id})` : s.title);
  }
  return result;
}
```

Preserve every doc comment from the original file that still applies (the "why" behind roster-vs-archived, the `knownSessionIds` reload safety) — copy them onto their new homes rather than dropping them; the excerpt above condenses them for this plan document only.

- [ ] **Step 5: Run, confirm pass**

Run: `yarn test:unit --grep "pane-layout"`
Expected: PASS

- [ ] **Step 6: Lint, types, commit**

```bash
yarn lint && yarn check-types
git add src/webview/components/pane-layout.ts src/test/unit/pane-layout.test.ts
git commit -m "feat: rebuild pane-layout reconciliation on the LayoutNode tree"
```

---

### Task 4: Host-side migration — `transcript-store.ts`

**Files:**
- Modify: `src/host/transcript-store.ts:15-19` (`StoredIndex`), `:31-35` (`emptyIndex`), `:413-427` (`readIndex`)
- Test: `src/test/unit/transcript-store.test.ts` *(check whether this file exists first — if a differently-named existing suite already covers `transcript-store.ts`, add to it instead of creating a duplicate)*

**Interfaces:**
- Consumes: `LayoutNode` from `../protocol/messages` (or the local structural mirror already used elsewhere in this file — match whatever `transcript-store.ts` already imports `PaneLayout` from).
- Produces: `readIndex()` now always returns the tree-shaped `StoredIndex.layout`, migrating a legacy on-disk `{orientation, panes}` shape transparently.

- [ ] **Step 1: Write the failing migration test**

```ts
// src/test/unit/transcript-store.test.ts (add a suite; create the file if none exists, following the module's own fs-mocking pattern — read a couple of its existing tests first for the exact mkdtemp/rootDir setup style)
suite('transcript-store legacy layout migration', () => {
  test('readIndex wraps a legacy {orientation, panes} shape into a LayoutNode tree', async () => {
    // Write a raw index.json with the OLD shape directly (bypassing writeIndex,
    // which now only ever writes the new shape) to `<rootDir>/index.json`,
    // matching whatever temp-dir fixture the existing suite in this file uses.
    const legacy = {
      version: TRANSCRIPT_VERSION,
      sessions: [],
      layout: { orientation: 'horizontal', panes: [{ sessionId: 'a', size: 60 }, { sessionId: 'b', size: 40 }] },
    };
    await fs.writeFile(path.join(rootDir, 'index.json'), JSON.stringify(legacy), 'utf8');

    const store = new TranscriptStore(rootDir);
    const index = await store.readIndex();

    assert.deepStrictEqual(index.layout, {
      root: {
        kind: 'split', orientation: 'horizontal', size: 100,
        children: [
          { kind: 'leaf', sessionId: 'a', size: 60 },
          { kind: 'leaf', sessionId: 'b', size: 40 },
        ],
      },
      presets: [],
    });
  });

  test('readIndex passes a modern {root, presets} shape through unchanged', async () => {
    const modern = {
      version: TRANSCRIPT_VERSION,
      sessions: [],
      layout: { root: { kind: 'leaf', sessionId: 'a', size: 100 }, presets: [{ id: 'p1', name: 'Mine', builtin: false, root: { kind: 'leaf', sessionId: null, size: 100 } }] },
    };
    await fs.writeFile(path.join(rootDir, 'index.json'), JSON.stringify(modern), 'utf8');

    const store = new TranscriptStore(rootDir);
    const index = await store.readIndex();

    assert.deepStrictEqual(index.layout, modern.layout);
  });
});
```

Adjust `rootDir`/`fs`/`TranscriptStore` construction to match whatever the existing suite in this test file already sets up — read it first.

- [ ] **Step 2: Run, confirm it fails**

Run: `yarn test:unit --grep "legacy layout migration"`
Expected: FAIL — `readIndex` still returns the legacy shape verbatim, or `emptyIndex().layout` is still the old shape.

- [ ] **Step 3: Implement the migration**

`src/host/transcript-store.ts:15-19` — update `StoredIndex`:

```ts
export interface StoredIndex {
  version: number;
  sessions: SessionState[];
  layout: PaneLayout; // PaneLayout is now { root: LayoutNode; presets: LayoutPreset[] }
}
```

`:31-35` — `emptyIndex()`:

```ts
const emptyIndex = (): StoredIndex => ({
  version: TRANSCRIPT_VERSION,
  sessions: [],
  layout: { root: { kind: 'leaf', sessionId: null, size: 100 }, presets: [] },
});
```

`:413-427` — `readIndex()`, add the migration just before returning:

```ts
async readIndex(): Promise<StoredIndex> {
  try {
    const raw = await fs.readFile(path.join(this.rootDir, 'index.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredIndex> & { layout?: unknown };
    if (parsed.version !== TRANSCRIPT_VERSION) { return emptyIndex(); }
    return {
      version: TRANSCRIPT_VERSION,
      sessions: parsed.sessions ?? [],
      layout: migrateLayout(parsed.layout) ?? emptyIndex().layout,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return emptyIndex(); }
    throw err;
  }
}
```

Add, in the same file, near `emptyIndex`:

```ts
/**
 * Upgrades a legacy `{orientation, panes}` layout (single row/column, no
 * tree) into the current `{root, presets}` shape on first read. Applied
 * once, here; the on-disk shape is rewritten in the new form the next time
 * the index is saved through the existing `writeIndex` path — no dedicated
 * migration script or version bump, the loader just recognizes the absence
 * of `root` as "this is the old shape."
 */
function migrateLayout(layout: unknown): PaneLayout | undefined {
  if (layout === undefined || layout === null || typeof layout !== 'object') { return undefined; }
  if ('root' in layout) { return layout as PaneLayout; }
  const legacy = layout as { orientation: 'vertical' | 'horizontal'; panes: { sessionId: string; size: number }[] };
  if (legacy.panes.length === 0) {
    return { root: { kind: 'leaf', sessionId: null, size: 100 }, presets: [] };
  }
  return {
    root: {
      kind: 'split', orientation: legacy.orientation, size: 100,
      children: legacy.panes.map((p) => ({ kind: 'leaf' as const, sessionId: p.sessionId, size: p.size })),
    },
    presets: [],
  };
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `yarn test:unit --grep "legacy layout migration"`
Expected: PASS

- [ ] **Step 5: Lint, types, commit**

```bash
yarn lint && yarn check-types
git add src/host/transcript-store.ts src/test/unit/transcript-store.test.ts
git commit -m "feat: migrate legacy flat pane layout to LayoutNode tree on load"
```

---

### Task 5: `session-manager.ts` — tree-aware `remove()`, `replaceSession()`, `savePreset()`/`deletePreset()`

**Files:**
- Modify: `src/host/session-manager.ts:78` (`paneLayout` field type — no code change beyond the type now resolving to the tree shape), `:1724-1745` (`remove()`), add `replaceSession()`, `savePreset()`, `deletePreset()`
- Test: `src/test/unit/session-manager.test.ts` *(read the file first for its existing fixture/setup conventions — likely a `FakeProvider`-backed harness; match it exactly)*

**Interfaces:**
- Consumes: `removeSession`, `replaceLeafSession`, `stripSessionIds` from `../webview/components/layout-tree` *(host importing a webview-tree pure module is new — confirm during Step 1 whether `layout-tree.ts` needs relocating to a shared, neither-host-nor-webview-owned location instead; if the existing codebase has a precedent for host code importing pure webview logic, follow it, otherwise move `layout-tree.ts` to `src/shared/layout-tree.ts` and update Task 2's file path plus every later task's imports accordingly before proceeding)*.
- Produces: `async replaceSession(id: SessionId): Promise<void>`, `async savePreset(name: string): Promise<void>`, `async deletePreset(id: string): Promise<void>`.

- [ ] **Step 1: Resolve the layout-tree location question**

Before writing any code in this task, check: does anything else in `src/host/` import from `src/webview/`? (`Grep` for `from '../webview` or similar across `src/host/`.) If nothing does, move `layout-tree.ts` (and its test) to `src/shared/layout-tree.ts` / `src/test/unit/layout-tree.test.ts` unchanged in content, update the two import paths in `pane-layout.ts` and its test from Task 3, rerun `yarn test:unit --grep "layout-tree"` and `--grep "pane-layout"` to confirm both suites still pass, then commit that move on its own before continuing:

```bash
git mv src/webview/components/layout-tree.ts src/shared/layout-tree.ts
# update the two import sites
git add -A
git commit -m "chore: relocate layout-tree to src/shared, host now consumes it too"
```

- [ ] **Step 2: Write the failing test for `remove()`**

```ts
// added to src/test/unit/session-manager.test.ts — match this file's existing setup exactly
test('remove() drops the session\'s leaf from the tree, collapsing its split', async () => {
  const manager = /* however the existing suite constructs one, e.g. makeManager() */;
  const a = await manager.create('fake', '/tmp');
  const b = await manager.create('fake', '/tmp');
  manager.setLayout({
    root: {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: a.state.id, size: 50 },
        { kind: 'leaf', sessionId: b.state.id, size: 50 },
      ],
    },
    presets: [],
  });

  await manager.remove(a.state.id);

  assert.deepStrictEqual(manager.layout().root, { kind: 'leaf', sessionId: b.state.id, size: 100 });
});
```

- [ ] **Step 3: Run, confirm it fails**

Run: `yarn test:unit --grep "remove\(\) drops"`
Expected: FAIL — `remove()` still does `this.paneLayout.panes.filter(...)`, which no longer type-checks against the tree shape (this task is what fixes the resulting `check-types` break from Task 1).

- [ ] **Step 4: Fix `remove()`**

Replace `src/host/session-manager.ts:1738-1743`:

```ts
    this.paneLayout = { ...this.paneLayout, root: removeSession(this.paneLayout.root, id) };
    this.changed();
```

Add the import at the top of the file: `import { removeSession, replaceLeafSession, stripSessionIds } from '../shared/layout-tree';` (or the pre-move path if Step 1 concluded no move was needed — keep this consistent with whatever Step 1 decided).

- [ ] **Step 5: Run, confirm pass**

Run: `yarn test:unit --grep "remove\(\) drops"`
Expected: PASS

- [ ] **Step 6: Write the failing tests for `replaceSession`**

```ts
test('replaceSession creates the new session before closing the old one, then swaps the leaf', async () => {
  const manager = /* ... */;
  const a = await manager.create('fake', '/tmp', 'fake-model', undefined, 'default');
  manager.setLayout({ root: { kind: 'leaf', sessionId: a.state.id, size: 100 }, presets: [] });

  await manager.replaceSession(a.state.id);

  const root = manager.layout().root;
  assert.strictEqual(root.kind, 'leaf');
  assert.notStrictEqual((root as { sessionId: string }).sessionId, a.state.id);
  const newId = (root as { sessionId: string }).sessionId;
  const newState = manager.summaries().find((s) => s.id === newId);
  assert.strictEqual(newState?.providerId, 'fake');
  assert.strictEqual(newState?.model, 'fake-model');
  assert.strictEqual(newState?.cwd, '/tmp');
  // the old session is gone from the live roster's active set (archived or removed, per manager.close's own semantics)
  assert.strictEqual(manager.get(a.state.id), undefined);
});
```

- [ ] **Step 7: Run, confirm it fails**

Run: `yarn test:unit --grep "replaceSession creates"`
Expected: FAIL — `replaceSession` doesn't exist.

- [ ] **Step 8: Implement `replaceSession`**

Add to `session-manager.ts`, near `create()`/`close()`:

```ts
  /**
   * Closes the session in a pane and opens a fresh one with the same setup
   * in its place — the header's "Replace" action. Creates first,
   * deliberately: if `create()` throws (provider unavailable, etc.), the old
   * session and its leaf are untouched, matching "errors are state" — a
   * failed replace must not lose the session the user was trying to replace.
   */
  async replaceSession(id: SessionId): Promise<void> {
    const state = this.meta.get(id);
    if (!state) { return; }
    const fresh = await this.create(state.providerId, state.cwd, state.model, state.effort, state.permissionMode);
    await this.close(id);
    this.paneLayout = { ...this.paneLayout, root: replaceLeafSession(this.paneLayout.root, id, fresh.state.id) };
    this.emit({ t: 'layout-changed', layout: this.paneLayout });
    this.schedulePersist();
  }
```

- [ ] **Step 9: Run, confirm pass**

Run: `yarn test:unit --grep "replaceSession creates"`
Expected: PASS

- [ ] **Step 10: Write the failing tests for `savePreset`/`deletePreset`**

```ts
test('savePreset strips sessionIds from the current tree and appends it under a new id', async () => {
  const manager = /* ... */;
  const a = await manager.create('fake', '/tmp');
  manager.setLayout({ root: { kind: 'leaf', sessionId: a.state.id, size: 100 }, presets: [] });

  await manager.savePreset('My layout');

  const presets = manager.layout().presets;
  assert.strictEqual(presets.length, 1);
  assert.strictEqual(presets[0].name, 'My layout');
  assert.strictEqual(presets[0].builtin, false);
  assert.deepStrictEqual(presets[0].root, { kind: 'leaf', sessionId: null, size: 100 });
});

test('deletePreset removes a preset by id', async () => {
  const manager = /* ... */;
  await manager.savePreset('One');
  const id = manager.layout().presets[0].id;

  await manager.deletePreset(id);

  assert.strictEqual(manager.layout().presets.length, 0);
});
```

- [ ] **Step 11: Run, confirm fail**

Run: `yarn test:unit --grep "savePreset|deletePreset"`
Expected: FAIL — neither method exists.

- [ ] **Step 12: Implement `savePreset`/`deletePreset`**

```ts
  async savePreset(name: string): Promise<void> {
    const preset: LayoutPreset = {
      id: newSessionId(), // reuses the same id generator already imported for SessionState.id; a preset id has no other identity requirement
      name,
      builtin: false,
      root: stripSessionIds(this.paneLayout.root),
    };
    this.paneLayout = { ...this.paneLayout, presets: [...this.paneLayout.presets, preset] };
    this.emit({ t: 'layout-changed', layout: this.paneLayout });
    this.schedulePersist();
  }

  async deletePreset(id: string): Promise<void> {
    this.paneLayout = { ...this.paneLayout, presets: this.paneLayout.presets.filter((p) => p.id !== id) };
    this.emit({ t: 'layout-changed', layout: this.paneLayout });
    this.schedulePersist();
  }
```

If `newSessionId()` is specific to `SessionId`'s format in a way that reads oddly for a preset id, check its implementation during this step — a plain `crypto.randomUUID()` is an equally fine substitute if so; use whichever this file already has in scope.

- [ ] **Step 13: Run, confirm pass**

Run: `yarn test:unit --grep "savePreset|deletePreset"`
Expected: PASS

- [ ] **Step 14: Lint, types, commit**

```bash
yarn lint && yarn check-types
git add src/host/session-manager.ts src/test/unit/session-manager.test.ts
git commit -m "feat: replaceSession, savePreset, deletePreset on SessionManager"
```

---

### Task 6: `message-router.ts` wiring

**Files:**
- Modify: `src/host/message-router.ts:688-705` (`KNOWN_MESSAGE_TAGS`), `:719-731` (`isWireMessage`), add three new `case` handlers near `'close-session'`/`'delete-session'`

**Interfaces:**
- Consumes: `SessionManager.replaceSession`, `.savePreset`, `.deletePreset` from Task 5.
- Produces: routed `'replace-session'`, `'save-preset'`, `'delete-preset'`.

- [ ] **Step 1: Write the failing router test**

Find the existing `message-router.test.ts` (or equivalent) and match its style — it constructs a `MessageRouter` with a fake/mock `SessionManager` and asserts the right method was called. Add:

```ts
test('replace-session delegates to manager.replaceSession', async () => {
  const manager = { replaceSession: sinon_or_manual_spy() /* match existing mocking convention in this file */ };
  const router = makeRouter(manager);
  await router.handle({ t: 'replace-session', id: 's1' });
  assert.strictEqual(manager.replaceSession.calledWith('s1'), true); // adapt to whatever assertion style this suite already uses
});

test('save-preset delegates to manager.savePreset', async () => {
  const manager = { savePreset: /* spy */ };
  const router = makeRouter(manager);
  await router.handle({ t: 'save-preset', name: 'Mine' });
  assert.strictEqual(manager.savePreset.calledWith('Mine'), true);
});

test('delete-preset delegates to manager.deletePreset', async () => {
  const manager = { deletePreset: /* spy */ };
  const router = makeRouter(manager);
  await router.handle({ t: 'delete-preset', id: 'p1' });
  assert.strictEqual(manager.deletePreset.calledWith('p1'), true);
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `yarn test:unit --grep "replace-session delegates|save-preset delegates|delete-preset delegates"`
Expected: FAIL — unknown message tag / no matching case.

- [ ] **Step 3: Add the tags and cases**

`:688-705`, append to the `KNOWN_MESSAGE_TAGS` set literal: `'replace-session', 'save-preset', 'delete-preset',`

Add three cases, matching the `'close-session'` one-liner style at `:294-296`:

```ts
    case 'replace-session':
      await this.manager.replaceSession(msg.id);
      return;
    case 'save-preset':
      await this.manager.savePreset(msg.name);
      return;
    case 'delete-preset':
      await this.manager.deletePreset(msg.id);
      return;
```

`isWireMessage` (`:719-731`) needs no new special case — none of the three new messages carry a nested object needing shape validation the way `set-layout`'s `layout.panes` array did (their payloads are a bare string), so the generic tag-membership check already covers them.

- [ ] **Step 4: Run, confirm pass**

Run: `yarn test:unit --grep "replace-session delegates|save-preset delegates|delete-preset delegates"`
Expected: PASS

- [ ] **Step 5: Lint, types, commit**

```bash
yarn lint && yarn check-types
git add src/host/message-router.ts
git commit -m "feat: route replace-session/save-preset/delete-preset to SessionManager"
```

---

### Task 7: `reducer.ts` default layout

**Files:**
- Modify: `src/webview/reducer.ts:148` (default layout literal)

**Interfaces:**
- Consumes: nothing new — `local-layout`/`layout-changed` cases (`:196-200`) already assign `msg.layout` wholesale and need no change since `PaneLayout`'s shape change is opaque to them.

- [ ] **Step 1: Update the default**

`src/webview/reducer.ts:148`, replace:

```ts
layout: { orientation: 'vertical', panes: [] },
```

with:

```ts
layout: { root: { kind: 'leaf', sessionId: null, size: 100 }, presets: [] },
```

- [ ] **Step 2: `yarn check-types`**

Expected: the count of remaining errors should now be limited to `pane-group.tsx`, `session-header.tsx`, `session-picker.tsx` and their tests — everything Task 3–6 touched should be clean. Confirm no error appears outside those files; if one does, note it for the task that should have covered it.

- [ ] **Step 3: Commit**

```bash
git add src/webview/reducer.ts
git commit -m "chore: default ClientState.layout to an empty LayoutNode tree"
```

---

### Task 8: `layout-node-view.tsx` — recursive renderer, no drag yet

**Files:**
- Create: `src/webview/components/layout-node-view.tsx`
- Modify: `src/webview/components/pane-group.tsx` (delegate to the new component; keep the empty-roster branch, `:147-226`, unchanged)
- Modify: `src/webview/components/empty-slot.tsx` *(new — created here since the renderer needs a leaf-empty branch immediately, drag support added in Task 9)*
- Modify: `src/test/dom/pane-group.test.tsx` (rebuild the fixtures that build `state.layout` by hand; keep every existing assertion's intent)

**Interfaces:**
- Consumes: `visibleLeaves`, `rosterSessionIds`, `accessibleTitles` from `./pane-layout`; `LayoutNode` from `../../protocol/messages`.
- Produces: `LayoutNodeView({node, path, ...})` recursive component; `EmptySlot({onAssign, assignableSessions})`.

- [ ] **Step 1: Read the current `pane-group.tsx` and `pane-group.test.tsx` in full**

(Already reproduced above in the exploration — 343 and 448 lines respectively.) Every doc comment explaining focus-preservation (`:33-78`), the empty-roster state (`:135-226`), and the a11y naming (`names`/`accessibleTitles`) must survive this refactor unchanged in behavior — this task only changes *how* the pane list is produced and rendered, not any of that surrounding logic.

- [ ] **Step 2: Write the failing DOM test for basic recursive rendering**

Add to (or replace the relevant section of) `pane-group.test.tsx`, using the existing `hydrate(paneIds, rosterIds)` helper's style but rebuilt for a tree — update that helper first:

```tsx
// helper rebuilt for the tree shape, same call sites as before
function hydrate(sessionIds: string[], rosterIds: string[] = sessionIds) {
  sendFromHost({
    t: 'hydrate',
    sessions: rosterIds.map((id) => summary({ id })),
    layout: layoutOf(sessionIds), // from src/test/fixtures/protocol.ts, Task 1
    snapshots: sessionIds.map((id) => snapshot({ id })),
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

test('a split root renders every leaf as its own pane', () => {
  renderApp();
  hydrate(['s1', 's2']);
  assert.strictEqual(screen.getAllByRole('region', { name: /Session:/ }).length, 2);
});

test('a nested split renders a leaf at any depth', () => {
  renderApp();
  sendFromHost({
    t: 'hydrate',
    sessions: [summary({ id: 's1' }), summary({ id: 's2' }), summary({ id: 's3' })],
    layout: {
      root: {
        kind: 'split', orientation: 'horizontal', size: 100,
        children: [
          { kind: 'leaf', sessionId: 's1', size: 50 },
          {
            kind: 'split', orientation: 'vertical', size: 50,
            children: [
              { kind: 'leaf', sessionId: 's2', size: 50 },
              { kind: 'leaf', sessionId: 's3', size: 50 },
            ],
          },
        ],
      },
      presets: [],
    },
    snapshots: [snapshot({ id: 's1' }), snapshot({ id: 's2' }), snapshot({ id: 's3' })],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
  assert.strictEqual(screen.getAllByRole('region', { name: /Session:/ }).length, 3);
});

test('an empty leaf renders the assign-slot placeholder, not a pane', () => {
  renderApp();
  sendFromHost({
    t: 'hydrate',
    sessions: [summary({ id: 's1' }), summary({ id: 's2' })],
    layout: {
      root: {
        kind: 'split', orientation: 'vertical', size: 100,
        children: [
          { kind: 'leaf', sessionId: 's1', size: 50 },
          { kind: 'leaf', sessionId: null, size: 50 },
        ],
      },
      presets: [],
    },
    snapshots: [snapshot({ id: 's1' })],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
  assert.strictEqual(screen.getAllByRole('region', { name: /Session:/ }).length, 1);
  assert.strictEqual(screen.getByRole('button', { name: /Assign a session/i }) !== undefined, true);
});
```

Keep every other existing test in the file (orientation resize, focus-preservation, empty-state copy, `layout-changed` echo) intact — they exercise `App`/`PaneGroup` behavior that doesn't change in this task, only their `hydrate`/fixture calls need the new tree shape, which the rebuilt `hydrate` helper above already gives them for free.

- [ ] **Step 3: Run, confirm the three new tests fail**

Run: `yarn test:dom --grep "split root renders|nested split renders|empty leaf renders"`
Expected: FAIL — `layout-node-view.tsx` doesn't exist yet; `pane-group.tsx` still assumes a flat array.

- [ ] **Step 4: Write `empty-slot.tsx`**

```tsx
// src/webview/components/empty-slot.tsx
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { PlusIcon } from "lucide-react";
import type { SessionSummary } from "../../protocol/messages";

interface EmptySlotProps {
  /** Roster sessions not currently placed anywhere in the tree — the only sessions this slot can legally take. */
  assignable: SessionSummary[];
  onAssign: (sessionId: string) => void;
}

/**
 * An empty leaf's placeholder — assign-picker only, no create-a-new-session
 * affordance here (that's `SessionCreateMenu`, in the toolbar, unrelated to
 * a specific leaf). If there is nothing left to assign, the button still
 * renders (a stable, always-real slot) but disabled with a reason, matching
 * this panel's "an action that can only ever refuse is worse than an absent
 * one" convention elsewhere — except here the refusal is transient (every
 * roster session is already placed) rather than permanent, so keeping the
 * door visible-but-disabled is honest instead of misleading.
 */
export function EmptySlot({ assignable, onAssign }: EmptySlotProps) {
  return (
    <div className={cn("flex h-full items-center justify-center border border-dashed border-border/60")}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" disabled={assignable.length === 0} />}
        >
          <PlusIcon aria-hidden />
          {assignable.length === 0 ? "No sessions to assign" : "Assign a session…"}
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {assignable.map((s) => (
            <DropdownMenuItem key={s.id} onClick={() => onAssign(s.id)}>
              {s.title}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
```

- [ ] **Step 5: Write `layout-node-view.tsx`**

This owns the recursion `pane-group.tsx` used to do flat; it reuses the exact `ResizablePanel`/pane-content JSX `pane-group.tsx` already had, just parameterized by a `LayoutNode` instead of a flat pane entry:

```tsx
// src/webview/components/layout-node-view.tsx
import { Fragment } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { Layout, LayoutChangedMeta } from "react-resizable-panels" with { "resolution-mode": "import" };
import type { LayoutNode } from "../../protocol/messages";
import { EmptySlot } from "./empty-slot";
import { PaneContent } from "./pane-content";
import type { LeafDisplayState } from "./pane-layout";

export interface DisplayNode {
  node: LayoutNode;
  /** Only meaningful for a `leaf` node — see `leafDisplayState`. */
  state?: LeafDisplayState;
}

interface LayoutNodeViewProps {
  node: LayoutNode;
  path: number[];
  narrow: boolean;
  leafState: (sessionId: string | null) => LeafDisplayState;
  names: Map<string, string>;
  activeId: string | null;
  assignableSessions: import("../../protocol/messages").SessionSummary[];
  onAssign: (path: number[], sessionId: string) => void;
  onLayoutChanged: (path: number[], layout: Layout, meta: LayoutChangedMeta, children: LayoutNode[]) => void;
}

/** Recursive `LayoutNode` renderer — a `split` becomes a nested `ResizablePanelGroup`, a `leaf` becomes either the real pane, an `EmptySlot`, or (a `pending` leaf) nothing interactive. */
export function LayoutNodeView(props: LayoutNodeViewProps) {
  const { node, path, narrow, leafState, names, activeId, assignableSessions, onAssign, onLayoutChanged } = props;

  if (node.kind === "leaf") {
    const state = leafState(node.sessionId);
    if (state === "empty") {
      return <EmptySlot assignable={assignableSessions} onAssign={(id) => onAssign(path, id)} />;
    }
    if (state === "pending") {
      // Transient — corrected by the next reconcile pass, never interactive.
      return <div className="h-full" />;
    }
    return (
      <PaneContent
        sessionId={node.sessionId!}
        active={activeId === node.sessionId}
        accessibleTitle={names.get(node.sessionId!)!}
      />
    );
  }

  const orientation = narrow ? "vertical" : node.orientation;
  return (
    <ResizablePanelGroup
      orientation={orientation}
      aria-label="Split group"
      onLayoutChanged={(layout, meta) => onLayoutChanged(path, layout, meta, node.children)}
    >
      {node.children.map((child, i) => (
        <Fragment key={i}>
          {i > 0 && <ResizableHandle withHandle />}
          <ResizablePanel
            id={`${path.join("-")}-${i}`}
            defaultSize={`${child.size}%`}
            minSize="15%"
            collapsible
          >
            <LayoutNodeView {...props} node={child} path={[...path, i]} />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}
```

Note: this task extracts the pane-content JSX (the `MessageScrollerProvider` / `SessionHeader` / `Transcript` / `Composer` block, `pane-group.tsx:304-335`) into a new `pane-content.tsx` so both the old flat renderer's replacement and any leaf, at any depth, can mount it identically. Do that extraction as part of this step — create `src/webview/components/pane-content.tsx` with that block verbatim (parameterized the same way `pane-group.tsx` already parameterizes it: `pane`, `model`, `models`, `unavailableReason`, `accessibleTitle`), and have `PaneContent` in `layout-node-view.tsx` above read `state.byId[sessionId]`/`state.catalog` from `useStore()` itself rather than threading them through every recursive call — keeps `LayoutNodeViewProps` from ballooning with data every leaf can already read from the store directly.

- [ ] **Step 6: Rewrite `pane-group.tsx` to delegate**

Keep `:1-146` (imports, focus-preservation effects, the empty-roster branch) exactly as they are, save for what must change: `visiblePanes` → `visibleLeaves`, and the resize handler moves into `layout-node-view.tsx`'s `onLayoutChanged` prop, which here becomes a small function that reconstructs the changed subtree's sizes and posts `set-layout` with the *whole* new root (not just the changed subtree) — `replaceAt` from `layout-tree.ts` (or its relocated `shared/` home) does that:

```tsx
  const assignableSessions = state.sessions
    .filter((s) => !leafSessionIds(state.layout.root).includes(s.id))
    .map((s) => state.byId[s.id]?.summary)
    .filter((s): s is SessionSummary => s !== undefined);

  const handleAssign = (path: number[], sessionId: string) => {
    post({ t: "set-layout", layout: { ...state.layout, root: assignAt(state.layout.root, path, sessionId) } });
  };

  const handleLayoutChanged = (path: number[], layout: Layout, meta: LayoutChangedMeta, children: LayoutNode[]) => {
    if (!meta.isUserInteraction) { return; }
    const resized: LayoutNode = {
      kind: "split",
      orientation: children[0] ? (at(state.layout.root, path) as { orientation: "vertical" | "horizontal" }).orientation : "vertical",
      size: (at(state.layout.root, path) as LayoutNode).size,
      children: children.map((child, i) => ({ ...child, size: layout[`${path.join("-")}-${i}`] ?? child.size })),
    };
    post({ t: "set-layout", layout: { ...state.layout, root: replaceAt(state.layout.root, path, resized) } });
  };
```

`at`/`replaceAt` are not exported from `layout-tree.ts` in Task 2 (they're module-private helpers there) — export them in this task (`layout-tree.ts`, drop the missing `export` keyword on both), since `pane-group.tsx` now needs the same "replace the node at a path" operation `splitAt`/`assignAt` already use internally. Add a unit test for `replaceAt` alongside them in `layout-tree.test.ts` while doing so, mirroring the existing `assignAt` test's shape.

Replace the render body (`:228-343`) with:

```tsx
      <LayoutNodeView
        node={state.layout.root}
        path={[]}
        narrow={narrow}
        leafState={(sessionId) => leafDisplayState(sessionId, roster, snapshotArrived)}
        names={names}
        activeId={activeId}
        assignableSessions={assignableSessions}
        onAssign={handleAssign}
        onLayoutChanged={handleLayoutChanged}
      />
```

`names` must now be computed from `visibleLeaves(...).filter(l => l.state === 'ready')` instead of the old flat `panes` array, and the top-level `panes.length === 0` check that gates the empty-roster branch becomes `visibleLeaves(state.layout.root, roster, snapshotArrived).filter(l => l.state === 'ready').length === 0`.

- [ ] **Step 7: Run, confirm the three new tests and the rest of the suite pass**

Run: `yarn test:dom --grep "PaneGroup"`
Expected: PASS across the whole file — both the three new tests and every pre-existing one, now running against the tree-shaped fixtures.

- [ ] **Step 8: Detector, lint, types, commit**

```bash
node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/layout-node-view.tsx src/webview/components/empty-slot.tsx src/webview/components/pane-content.tsx src/webview/components/pane-group.tsx
yarn lint && yarn check-types
git add src/webview/components/layout-node-view.tsx src/webview/components/empty-slot.tsx src/webview/components/pane-content.tsx src/webview/components/pane-group.tsx src/webview/components/layout-tree.ts src/test/dom/pane-group.test.tsx src/test/unit/layout-tree.test.ts src/test/fixtures/protocol.ts
git commit -m "feat: recursive LayoutNode rendering with empty-slot placeholders"
```

(Adjust the `layout-tree.ts` path in the `git add` above if Task 5's Step 1 relocated it to `src/shared/`.)

---

### Task 9: Drag-to-split

**Files:**
- Create: `src/webview/components/pane-drag-context.tsx`
- Modify: `src/webview/components/session-header.tsx` (drag handle)
- Modify: `src/webview/components/layout-node-view.tsx` (edge drop zones on each leaf)
- Modify: `src/test/dom/pane-group.test.tsx` (drag-to-split tests)

**Interfaces:**
- Consumes: native HTML5 `dragstart`/`dragover`/`drop` events (jsdom + `@testing-library/react`'s `fireEvent` supports these — confirm during Step 1 by checking `composer.tsx`'s own DOM test for the drop-simulation pattern already in use).
- Produces: `PaneDragProvider`, `usePaneDrag(): {draggingId: string|null, setDraggingId}`.

- [ ] **Step 1: Read `composer.tsx`'s drop-zone code and its DOM test**

Confirm the exact event-simulation pattern (`fireEvent.dragOver`, `dataTransfer` mocking, etc.) already proven to work in this jsdom setup, and match it rather than inventing a new one.

- [ ] **Step 2: Write `pane-drag-context.tsx`**

```tsx
// src/webview/components/pane-drag-context.tsx
import { createContext, useContext, useState, type ReactNode } from "react";

interface PaneDragValue {
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
}

const PaneDragContext = createContext<PaneDragValue | undefined>(undefined);

/**
 * Which session is mid-drag, shared above the whole `LayoutNodeView` tree.
 * Not carried in `dataTransfer` alone: jsdom's `DataTransfer.getData` during
 * `dragover` (as opposed to the final `drop`) is unreliable across browsers
 * by spec (`getData` is only guaranteed non-empty on `drop`), so the per-edge
 * hover highlight — which must update on every `dragover`, not just at
 * `drop` — reads this context instead.
 */
export function PaneDragProvider({ children }: { children: ReactNode }) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  return <PaneDragContext.Provider value={{ draggingId, setDraggingId }}>{children}</PaneDragContext.Provider>;
}

export function usePaneDrag(): PaneDragValue {
  const value = useContext(PaneDragContext);
  if (!value) { throw new Error("usePaneDrag must be used inside PaneDragProvider"); }
  return value;
}
```

Wrap `PaneGroup`'s render (in `pane-group.tsx`, from Task 8) in `<PaneDragProvider>`.

- [ ] **Step 3: Write the failing drag-to-split DOM test**

```tsx
test('dropping on a pane\'s right edge splits it into a horizontal pair', () => {
  renderApp();
  hydrate(['s1', 's2']);
  const target = screen.getByLabelText(/Session: s2/i); // adjust to whatever accessible name the fixture's summary() produces
  const handle = screen.getByLabelText(/Drag s1/i); // the new grab handle added to session-header.tsx in Step 5 below

  fireEvent.dragStart(handle);
  const dropZone = within(target).getByTestId('drop-zone-right');
  fireEvent.dragOver(dropZone);
  fireEvent.drop(dropZone);

  const last = posted().at(-1);
  assert.strictEqual(last.t, 'set-layout');
  assert.strictEqual(last.layout.root.kind, 'split');
  // s1 was removed from its old leaf and collapsed; s2's old leaf is now a
  // horizontal split of [s2, s1] — the exact tree depends on the starting
  // fixture layout, assert the shape the two-pane hydrate() above produces.
});

test('dropping on an empty leaf assigns directly, no split created', () => {
  renderApp();
  sendFromHost({
    t: 'hydrate',
    sessions: [summary({ id: 's1' }), summary({ id: 's2' })],
    layout: {
      root: {
        kind: 'split', orientation: 'vertical', size: 100,
        children: [
          { kind: 'leaf', sessionId: 's1', size: 50 },
          { kind: 'leaf', sessionId: null, size: 50 },
        ],
      },
      presets: [],
    },
    snapshots: [snapshot({ id: 's1' })],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
  // ... drag s1's handle onto the empty slot, assert the resulting set-layout has no new split node, just s1 assigned into the second leaf, and the first leaf collapsed to empty (or removed) — pin down the exact expectation once the fixture's shape is in front of you.
});
```

Leave the precise post-drop tree assertion for the second test as a TODO to fill in *while implementing*, not in the final plan — by the time this step is written for real, Step 2/8's fixtures are known and the assertion is mechanical; this plan gives the mechanism, not the exact object literal, since it depends on exact starting fixture ids already defined above.

- [ ] **Step 4: Run, confirm it fails**

Run: `yarn test:dom --grep "dropping on a pane|dropping on an empty leaf"`
Expected: FAIL — no drag handle, no drop zones yet.

- [ ] **Step 5: Add the drag handle to `session-header.tsx`**

Near the existing "Hide" button (`:274-289`), add a grab handle, only rendered when `usePaneDrag` is available (it's inside `PaneDragProvider` from Task 8/9's wrapping):

```tsx
import { GripVerticalIcon } from "lucide-react";
import { usePaneDrag } from "./pane-drag-context";
// ...
  const { setDraggingId } = usePaneDrag();
// ... inside the JSX, before the Hide button:
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Drag ${accessibleTitle} to move or split`}
        draggable
        onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDraggingId(s.id); }}
        onDragEnd={() => setDraggingId(null)}
        className="shrink-0 cursor-grab active:cursor-grabbing"
      >
        <GripVerticalIcon aria-hidden />
      </Button>
```

- [ ] **Step 6: Add edge drop zones to `layout-node-view.tsx`'s leaf branch**

```tsx
import { usePaneDrag } from "./pane-drag-context";
import { splitAt, assignAt, removeSession } from "../../shared/layout-tree"; // path per Task 5 Step 1's resolution

// inside the `leaf` branch, when state === 'ready':
  const { draggingId, setDraggingId } = usePaneDrag();
  const [hoverEdge, setHoverEdge] = useState<"top" | "bottom" | "left" | "right" | null>(null);
  const isDropTarget = draggingId !== null && draggingId !== node.sessionId;

  const handleDrop = (edge: "top" | "bottom" | "left" | "right") => {
    if (draggingId === null) { return; }
    setHoverEdge(null);
    setDraggingId(null);
    props.onSplit(path, edge === "left" || edge === "right" ? "horizontal" : "vertical", draggingId);
  };

  return (
    <div className="relative h-full">
      <PaneContent sessionId={node.sessionId!} active={activeId === node.sessionId} accessibleTitle={names.get(node.sessionId!)!} />
      {isDropTarget && (["top", "bottom", "left", "right"] as const).map((edge) => (
        <div
          key={edge}
          data-testid={`drop-zone-${edge}`}
          className={cn(
            "absolute z-10",
            edge === "top" && "inset-x-0 top-0 h-1/4",
            edge === "bottom" && "inset-x-0 bottom-0 h-1/4",
            edge === "left" && "inset-y-0 left-0 w-1/4",
            edge === "right" && "inset-y-0 right-0 w-1/4",
            hoverEdge === edge && "bg-ring/30",
          )}
          onDragOver={(e) => { e.preventDefault(); setHoverEdge(edge); }}
          onDragLeave={() => setHoverEdge((cur) => (cur === edge ? null : cur))}
          onDrop={(e) => { e.preventDefault(); handleDrop(edge); }}
        />
      ))}
    </div>
  );
```

And the `empty` branch's `EmptySlot` also becomes a drop target — dropping there calls `onAssign` directly rather than `onSplit` (no split node created, per the design doc), reusing the same `onDragOver`/`onDrop` pair on its root `div`.

`onSplit` is a new prop threaded down alongside `onAssign`/`onLayoutChanged`, implemented in `pane-group.tsx` next to `handleAssign`:

```tsx
  const handleSplit = (path: number[], orientation: "vertical" | "horizontal", draggedSessionId: string) => {
    const withoutDragged = removeSession(state.layout.root, draggedSessionId);
    // Path was computed against the pre-removal tree; removal only ever
    // collapses the dragged session's own old split, which cannot be an
    // ancestor of `path` (a session can't be dragged onto its own subtree —
    // draggingId !== node.sessionId already guards direct self-drop, and a
    // split containing the target leaf still has ≥2 children after removing
    // an unrelated leaf elsewhere in the tree, so `path` still resolves).
    const next = splitAt(withoutDragged, path, orientation, draggedSessionId);
    post({ t: "set-layout", layout: { ...state.layout, root: next } });
  };
```

Note the comment's claim needs one more real safeguard: if the dragged session's old leaf sits *inside* the same split branch being split (e.g. dragging one of two children of a 2-child split onto its own sibling), `removeSession` collapses that split before `path` is used, shifting indices. Handle this the simple, safe way — recompute `path` after removal by re-finding the *target* leaf's `sessionId` (not the dragged one) rather than trusting the pre-removal path:

```tsx
  const handleSplit = (path: number[], orientation: "vertical" | "horizontal", draggedSessionId: string) => {
    const targetSessionId = /* the leaf's own sessionId, passed alongside path from layout-node-view.tsx — add it to the onSplit call signature */;
    const withoutDragged = removeSession(state.layout.root, draggedSessionId);
    const freshPath = findPath(withoutDragged, targetSessionId);
    if (!freshPath) { return; } // target session itself vanished mid-drag (closed by another client) — no-op, matches "errors are state"
    const next = splitAt(withoutDragged, freshPath, orientation, draggedSessionId);
    post({ t: "set-layout", layout: { ...state.layout, root: next } });
  };
```

Update `onSplit`'s signature and the `layout-node-view.tsx` call site accordingly (`props.onSplit(path, targetSessionId, edge-derived-orientation, draggingId)`), and add `findPath` to the same import from `../../shared/layout-tree`.

- [ ] **Step 7: Run, confirm the drag tests and the rest of the suite pass**

Run: `yarn test:dom --grep "PaneGroup"`
Expected: PASS.

- [ ] **Step 8: Detector, lint, types, commit**

```bash
node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/pane-drag-context.tsx src/webview/components/session-header.tsx src/webview/components/layout-node-view.tsx src/webview/components/pane-group.tsx
yarn lint && yarn check-types
git add -A
git commit -m "feat: drag a session's header handle to split the layout at a pane edge"
```

---

### Task 10: Orientation toggle guarded to split roots

**Files:**
- Modify: `src/webview/components/session-picker.tsx` (the toggle button, `:237-274`, and `open`/`setPanes`/`toggle` at `:27-40`)
- Modify: whatever DOM test file covers `SessionPicker`'s toggle (find it first)

**Interfaces:**
- Consumes: `leafSessionIds`, `removeSession` from `../../shared/layout-tree` (replacing the old flat `open`/`toggle`/`setPanes` logic); `assignableSessions`-style "add to layout" now needs `layout-tree`'s append-at-top-level behavior — reuse `reconcilePaneLayout`'s newly-arrived-append shape by factoring it into a small exported helper in `pane-layout.ts` (`appendAtTop(root, sessionId): LayoutNode`) rather than duplicating that logic here.

- [ ] **Step 1: Read `session-picker.tsx` in full**

(Reproduced above, relevant excerpts at `:27-40`, `:111-138`, `:237-274`.)

- [ ] **Step 2: Extract `appendAtTop` in `pane-layout.ts`**

`reconcilePaneLayout` (Task 3) already contains this exact "wrap a bare leaf or extend an existing vertical split" logic inline for newly-arrived sessions. Factor it out so `session-picker.tsx`'s roster-checkbox "add" path can reuse it instead of re-deriving the rule:

```ts
// added to src/webview/components/pane-layout.ts
/** Appends `sessionId` as a new sibling at the top split level — wraps a bare leaf root into a 2-child vertical split, or extends an existing vertical top split, evenly resizing. Used both by reconcile's auto-open-on-create and by the roster checkbox's "show this session" toggle. */
export function appendAtTop(root: LayoutNode, sessionId: string): LayoutNode {
  const next = root.kind === 'leaf' && root.sessionId === null
    ? { kind: 'leaf' as const, sessionId, size: 100 }
    : {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [...(root.kind === 'split' && root.orientation === 'vertical' ? root.children : [root]), { kind: 'leaf' as const, sessionId, size: 0 }]
        .map((child, i, arr) => ({ ...child, size: 100 / arr.length })),
    };
  return next;
}
```

Update `reconcilePaneLayout`'s body (Task 3) to call `appendAtTop` instead of its inline duplicate, and re-run `yarn test:unit --grep "pane-layout"` to confirm the existing reconcile tests still pass unchanged (this is a pure refactor of Task 3's own code, not a behavior change).

- [ ] **Step 3: Write the failing tests for `appendAtTop` and the guarded toggle**

```ts
// added to src/test/unit/pane-layout.test.ts
suite('pane-layout appendAtTop', () => {
  test('wraps a single-leaf root into a 2-child vertical split', () => {
    const root: LayoutNode = { kind: 'leaf', sessionId: 'a', size: 100 };
    assert.deepStrictEqual(appendAtTop(root, 'b'), {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [{ kind: 'leaf', sessionId: 'a', size: 50 }, { kind: 'leaf', sessionId: 'b', size: 50 }],
    });
  });
});
```

```tsx
// added to session-picker's DOM test file
test('the orientation toggle is disabled when the root is a single leaf', () => {
  renderApp();
  hydrate(['s1']);
  const toggle = screen.getByRole('button', { name: /Split direction/i });
  assert.strictEqual(toggle.hasAttribute('disabled'), true);
});

test('the orientation toggle flips the root split\'s orientation when there is one', () => {
  renderApp();
  hydrate(['s1', 's2']);
  const toggle = screen.getByRole('button', { name: /Split direction/i });
  fireEvent.click(toggle);
  const last = posted().at(-1);
  assert.strictEqual(last.t, 'set-layout');
  assert.strictEqual(last.layout.root.orientation, 'horizontal');
});
```

- [ ] **Step 4: Run, confirm the new tests fail**

Run: `yarn test:unit --grep "appendAtTop"` and `yarn test:dom --grep "orientation toggle"`
Expected: FAIL.

- [ ] **Step 5: Update `session-picker.tsx`**

Replace `:27-40`:

```tsx
export function SessionPicker({ narrow, onReview, onFleet }: SessionPickerProps) {
  const { state, post } = useStore();
  const open = new Set(leafSessionIds(state.layout.root));
  const rootIsSplit = state.layout.root.kind === 'split';
  const horizontal = rootIsSplit && (state.layout.root as { orientation: 'vertical' | 'horizontal' }).orientation === 'horizontal';
  const needing = state.sessions.filter((s) => statusView(s.status).needsUser).length;

  const toggle = (id: SessionId) => {
    const nextRoot = open.has(id) ? removeSession(state.layout.root, id) : appendAtTop(state.layout.root, id);
    post({ t: 'set-layout', layout: { ...state.layout, root: nextRoot } });
    post({ t: 'set-visible', sessionIds: leafSessionIds(nextRoot) });
  };
```

Update the toggle button (`:237-274`) — `disabled={narrow}` becomes `disabled={narrow || !rootIsSplit}`, and its `onClick`:

```tsx
      onClick={() => {
        if (state.layout.root.kind !== 'split') { return; }
        post({
          t: 'set-layout',
          layout: {
            ...state.layout,
            root: { ...state.layout.root, orientation: state.layout.root.orientation === 'vertical' ? 'horizontal' : 'vertical' },
          },
        });
      }}
```

Every call site of `setPanes` in the file (`SessionRow`'s `onToggle`) already routes through the rewritten `toggle` above — confirm no other direct `evenlySizedPanes`/flat-panes reference remains in this file (`grep -n "panes\|orientation" src/webview/components/session-picker.tsx` after this edit should show nothing outside what was just written).

- [ ] **Step 6: Run, confirm pass**

Run: `yarn test:unit --grep "appendAtTop"` and `yarn test:dom --grep "orientation toggle"`
Expected: PASS. Also re-run the full `pane-group`/`session-picker` DOM suites to confirm nothing else broke.

- [ ] **Step 7: Detector, lint, types, commit**

```bash
node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/session-picker.tsx
yarn lint && yarn check-types
git add -A
git commit -m "feat: guard the orientation toggle to split roots, roster checkbox uses the tree"
```

---

### Task 11: Built-in presets + apply

**Files:**
- Create: `src/webview/components/layout-presets.ts` (built-in constants, `shapeMatches`)
- Create: `src/webview/components/layout-presets-menu.tsx`
- Modify: `src/webview/components/session-picker.tsx` (mount the new menu next to the orientation toggle)
- Test: `src/test/unit/layout-presets.test.ts`, `src/test/dom/layout-presets.test.tsx`

**Interfaces:**
- Consumes: `fillShape`, `slotCount`, `leafSessionIds` from `../../shared/layout-tree`.
- Produces: `BUILTIN_PRESETS: LayoutPreset[]`, `shapeMatches(root, shape): boolean`, `<LayoutPresetsMenu />`.

- [ ] **Step 1: Write the failing unit tests**

```ts
// src/test/unit/layout-presets.test.ts
import * as assert from 'assert';
import { BUILTIN_PRESETS, shapeMatches } from '../../webview/components/layout-presets';

suite('layout-presets BUILTIN_PRESETS', () => {
  test('every built-in preset is shape-only (no sessionId anywhere)', () => {
    for (const preset of BUILTIN_PRESETS) {
      const hasSession = JSON.stringify(preset.root).includes('"sessionId":"');
      assert.strictEqual(hasSession, false, `${preset.name} has a non-null sessionId`);
    }
  });

  test('2x2 grid has 4 slots', () => {
    const grid = BUILTIN_PRESETS.find((p) => p.id === 'grid-2x2')!;
    assert.strictEqual(grid.root.kind, 'split');
  });
});

suite('layout-presets shapeMatches', () => {
  test('a filled tree matches the shape it was filled from', () => {
    const shape = BUILTIN_PRESETS.find((p) => p.id === 'stack-2')!.root;
    const filled = { kind: 'split' as const, orientation: 'vertical' as const, size: 100, children: [{ kind: 'leaf' as const, sessionId: 'a', size: 50 }, { kind: 'leaf' as const, sessionId: 'b', size: 50 }] };
    assert.strictEqual(shapeMatches(filled, shape), true);
  });

  test('a differently-shaped tree does not match', () => {
    const shape = BUILTIN_PRESETS.find((p) => p.id === 'stack-2')!.root;
    const other = { kind: 'leaf' as const, sessionId: 'a', size: 100 };
    assert.strictEqual(shapeMatches(other, shape), false);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `yarn test:unit --grep "layout-presets"`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `layout-presets.ts`**

```ts
// src/webview/components/layout-presets.ts
import type { LayoutNode, LayoutPreset } from '../../protocol/messages';

const leaf = (): LayoutNode => ({ kind: 'leaf', sessionId: null, size: 50 });

export const BUILTIN_PRESETS: LayoutPreset[] = [
  { id: 'stack-2', name: '2 rows', builtin: true, root: { kind: 'split', orientation: 'vertical', size: 100, children: [leaf(), leaf()] } },
  { id: 'columns-2', name: '2 columns', builtin: true, root: { kind: 'split', orientation: 'horizontal', size: 100, children: [leaf(), leaf()] } },
  { id: 'columns-3', name: '3 columns', builtin: true, root: { kind: 'split', orientation: 'horizontal', size: 100, children: [{ ...leaf(), size: 100 / 3 }, { ...leaf(), size: 100 / 3 }, { ...leaf(), size: 100 / 3 }] } },
  {
    id: 'grid-2x2', name: '2x2 grid', builtin: true,
    root: {
      kind: 'split', orientation: 'horizontal', size: 100,
      children: [
        { kind: 'split', orientation: 'vertical', size: 50, children: [leaf(), leaf()] },
        { kind: 'split', orientation: 'vertical', size: 50, children: [leaf(), leaf()] },
      ],
    },
  },
  {
    id: 'asym-1-2', name: '1 large + 2 stacked', builtin: true,
    root: {
      kind: 'split', orientation: 'horizontal', size: 100,
      children: [
        { ...leaf(), size: 50 },
        { kind: 'split', orientation: 'vertical', size: 50, children: [leaf(), leaf()] },
      ],
    },
  },
];

/** Structural equality ignoring `sessionId`/exact `size` — same kind/orientation/child count at every level, recursively. Used to highlight the currently-active preset, if any. */
export function shapeMatches(node: LayoutNode, shape: LayoutNode): boolean {
  if (node.kind !== shape.kind) { return false; }
  if (node.kind === 'leaf') { return true; }
  const shapeChildren = (shape as { children: LayoutNode[] }).children;
  if (node.orientation !== (shape as { orientation: 'vertical' | 'horizontal' }).orientation) { return false; }
  if (node.children.length !== shapeChildren.length) { return false; }
  return node.children.every((child, i) => shapeMatches(child, shapeChildren[i]));
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `yarn test:unit --grep "layout-presets"`
Expected: PASS.

- [ ] **Step 5: Write the failing DOM tests for apply**

```tsx
// src/test/dom/layout-presets.test.tsx
import * as assert from 'assert';
import { screen, fireEvent } from '@testing-library/react';
import { catalog, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, sendFromHost } from './harness';

function hydrateTwo() {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary({ id: 's1' }), summary({ id: 's2' })],
    layout: { root: { kind: 'leaf', sessionId: 's1', size: 100 }, presets: [] },
    snapshots: [snapshot({ id: 's1' })],
    catalog: catalog(), unavailable: [], usage: {},
  });
}

suite('layout presets menu', () => {
  test('applying a preset with room fills it with the currently-visible sessions', () => {
    renderApp();
    hydrateTwo();
    fireEvent.click(screen.getByRole('button', { name: /Layout presets/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /2 rows/i }));
    const last = posted().at(-1);
    assert.strictEqual(last.t, 'set-layout');
    assert.strictEqual(last.layout.root.kind, 'split');
    assert.deepStrictEqual(last.layout.root.children.map((c: { sessionId: string | null }) => c.sessionId), ['s1', null]);
  });

  test('a preset with fewer slots than visible sessions is disabled', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [summary({ id: 's1' }), summary({ id: 's2' }), summary({ id: 's3' })],
      layout: {
        root: { kind: 'split', orientation: 'vertical', size: 100, children: [{ kind: 'leaf', sessionId: 's1', size: 34 }, { kind: 'leaf', sessionId: 's2', size: 33 }, { kind: 'leaf', sessionId: 's3', size: 33 }] },
        presets: [],
      },
      snapshots: [snapshot({ id: 's1' }), snapshot({ id: 's2' }), snapshot({ id: 's3' })],
      catalog: catalog(), unavailable: [], usage: {},
    });
    fireEvent.click(screen.getByRole('button', { name: /Layout presets/i }));
    const stack2 = screen.getByRole('menuitem', { name: /2 rows/i });
    assert.strictEqual(stack2.getAttribute('aria-disabled'), 'true');
  });
});
```

- [ ] **Step 6: Run, confirm fail**

Run: `yarn test:dom --grep "layout presets menu"`
Expected: FAIL — no menu yet.

- [ ] **Step 7: Implement `layout-presets-menu.tsx` and mount it**

```tsx
// src/webview/components/layout-presets-menu.tsx
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { LayoutGridIcon } from "lucide-react";
import { leafSessionIds, fillShape, slotCount } from "../../shared/layout-tree";
import { BUILTIN_PRESETS, shapeMatches } from "./layout-presets";
import { useStore } from "../store";

export function LayoutPresetsMenu() {
  const { state, post } = useStore();
  const visibleIds = leafSessionIds(state.layout.root);
  const allPresets = [...BUILTIN_PRESETS, ...state.layout.presets];

  const apply = (root: import("../../protocol/messages").LayoutNode) => {
    const filled = fillShape(root, visibleIds);
    if (!filled) { return; } // more visible sessions than slots — button is disabled for this case, this is the belt-and-suspenders no-op
    post({ t: "set-layout", layout: { ...state.layout, root: filled } });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label="Layout presets" />}>
        <LayoutGridIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {BUILTIN_PRESETS.map((preset) => {
          const disabled = visibleIds.length > slotCount(preset.root);
          return (
            <DropdownMenuItem key={preset.id} disabled={disabled} onClick={() => apply(preset.root)}>
              {preset.name}
              {shapeMatches(state.layout.root, preset.root) && " ✓"}
            </DropdownMenuItem>
          );
        })}
        {state.layout.presets.length > 0 && <DropdownMenuSeparator />}
        {state.layout.presets.map((preset) => {
          const disabled = visibleIds.length > slotCount(preset.root);
          return (
            <DropdownMenuItem key={preset.id} disabled={disabled} onClick={() => apply(preset.root)}>
              {preset.name}
              {shapeMatches(state.layout.root, preset.root) && " ✓"}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => post({ t: "save-preset", name: window.prompt("Name this layout:") ?? "" })}>
          Save current layout…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

`window.prompt` is a placeholder for "ask for a name" — check first whether this codebase already has a small text-input dialog pattern vendored (the rename-in-header flow in `session-header.tsx:87-109` is inline-edit, not a prompt dialog) and a `Dialog`/`AlertDialog` primitive under `ui/`. If one exists, use it instead of `window.prompt` — a native browser prompt is exactly the kind of raw control this codebase's shadcn-only rule exists to rule out, so treat this as a hard blocker to resolve during implementation, not a nice-to-have. Build a two-field-free minimal `SavePresetDialog` (`Dialog` + `Input` + `Button`) alongside this component if nothing suitable already exists, following `bring-back-dialog.tsx`'s structure as a template (referenced in `session-header.tsx`'s imports).

Mount `<LayoutPresetsMenu />` in `session-picker.tsx`, immediately after the orientation toggle's `Tooltip`/`TooltipContent` closing tags and before `<SessionCreateMenu />` (`:274-276`).

- [ ] **Step 8: Run, confirm pass**

Run: `yarn test:dom --grep "layout presets menu"`
Expected: PASS.

- [ ] **Step 9: Detector, lint, types, commit**

```bash
node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/layout-presets-menu.tsx src/webview/components/session-picker.tsx
yarn lint && yarn check-types
git add -A
git commit -m "feat: built-in layout presets with apply, overflow-blocked when there's no room"
```

---

### Task 12: Save/delete custom presets — webview wiring

**Files:**
- Modify: `src/webview/components/layout-presets-menu.tsx` (replace the `window.prompt` placeholder from Task 11 with the real dialog, wire delete)
- Modify: `src/webview/reducer.ts` (confirm `layout-changed`/`local-layout` already carry `presets` through — they do, since `PaneLayout` is assigned wholesale; this step is a verification, not a code change, unless the dialog needs new local UI state in the reducer, which it should not)
- Test: `src/test/dom/layout-presets.test.tsx` (save/delete tests)

**Interfaces:**
- Consumes: `save-preset`/`delete-preset` messages from Task 1/6.
- Produces: a working save dialog, a delete action per user-saved preset row.

- [ ] **Step 1: Write the failing DOM tests**

```tsx
// appended to src/test/dom/layout-presets.test.tsx
test('save current layout as preset posts save-preset with the entered name', async () => {
  renderApp();
  hydrateTwo();
  fireEvent.click(screen.getByRole('button', { name: /Layout presets/i }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Save current layout/i }));
  fireEvent.change(screen.getByLabelText(/preset name/i), { target: { value: 'My grid' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
  const last = posted().at(-1);
  assert.deepStrictEqual(last, { t: 'save-preset', name: 'My grid' });
});

test('a saved preset appears in the menu after a layout-changed echo carrying it, and can be deleted', () => {
  renderApp();
  hydrateTwo();
  sendFromHost({
    t: 'layout-changed',
    layout: { root: { kind: 'leaf', sessionId: 's1', size: 100 }, presets: [{ id: 'p1', name: 'My grid', builtin: false, root: { kind: 'leaf', sessionId: null, size: 100 } }] },
  });
  fireEvent.click(screen.getByRole('button', { name: /Layout presets/i }));
  assert.strictEqual(screen.getByRole('menuitem', { name: /My grid/i }) !== undefined, true);
  fireEvent.click(screen.getByRole('button', { name: /Delete My grid/i }));
  const last = posted().at(-1);
  assert.deepStrictEqual(last, { t: 'delete-preset', id: 'p1' });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `yarn test:dom --grep "save current layout|saved preset appears"`
Expected: FAIL.

- [ ] **Step 3: Build `SavePresetDialog` and wire delete**

Follow whatever `Dialog` primitive Task 11 Step 7 found (or vendored). A minimal shape:

```tsx
// added to layout-presets-menu.tsx, or its own file if it grows past ~40 lines — split it out as save-preset-dialog.tsx if so
function SavePresetDialog({ open, onOpenChange, onSave }: { open: boolean; onOpenChange: (open: boolean) => void; onSave: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Save current layout</DialogTitle>
        <InputGroup>
          <InputGroupInput aria-label="Preset name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </InputGroup>
        <Button onClick={() => { if (name.trim()) { onSave(name.trim()); onOpenChange(false); setName(""); } }}>
          Save
        </Button>
      </DialogContent>
    </Dialog>
  );
}
```

Wire it into `LayoutPresetsMenu` (replacing the `window.prompt` item's `onClick` with `setDialogOpen(true)`, and the dialog's `onSave` posts `{t: 'save-preset', name}`), and give each user-saved preset row a per-row delete button:

```tsx
        {state.layout.presets.map((preset) => {
          const disabled = visibleIds.length > slotCount(preset.root);
          return (
            <div key={preset.id} className="flex items-center">
              <DropdownMenuItem disabled={disabled} onClick={() => apply(preset.root)} className="flex-1">
                {preset.name}
                {shapeMatches(state.layout.root, preset.root) && " ✓"}
              </DropdownMenuItem>
              <Button
                variant="ghost" size="icon-xs"
                aria-label={`Delete ${preset.name}`}
                onClick={(e) => { e.stopPropagation(); post({ t: "delete-preset", id: preset.id }); }}
              >
                <XIcon aria-hidden />
              </Button>
            </div>
          );
        })}
```

- [ ] **Step 4: Run, confirm pass**

Run: `yarn test:dom --grep "save current layout|saved preset appears"`
Expected: PASS.

- [ ] **Step 5: Detector, lint, types, commit**

```bash
node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/layout-presets-menu.tsx
yarn lint && yarn check-types
git add -A
git commit -m "feat: save and delete custom layout presets"
```

---

### Task 13: Replace-session button

**Files:**
- Modify: `src/webview/components/session-header.tsx` (new button next to Hide)
- Test: session-header's DOM test file (find exact name first)

**Interfaces:**
- Consumes: `{t: 'replace-session', id}` message (Task 1/6).

- [ ] **Step 1: Write the failing DOM test**

```tsx
test('Replace posts replace-session for this pane\'s session', () => {
  renderApp();
  hydrate(['s1']); // whatever this suite's own hydrate helper is named
  fireEvent.click(screen.getByRole('button', { name: /Replace/i }));
  assert.deepStrictEqual(posted().at(-1), { t: 'replace-session', id: 's1' });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `yarn test:dom --grep "Replace posts replace-session"`
Expected: FAIL.

- [ ] **Step 3: Add the button**

In `session-header.tsx`, next to the Hide button (`:274-289`):

```tsx
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Replace ${accessibleTitle}`}
        onClick={() => post({ t: "replace-session", id: s.id })}
        className="shrink-0"
      >
        <RefreshCwIcon aria-hidden />
      </Button>
```

`RefreshCwIcon` is already imported elsewhere in the codebase (`pane-group.tsx:4`) — import it here from `lucide-react` alongside the existing `PencilIcon`/`XIcon`/etc imports at the top of `session-header.tsx`.

- [ ] **Step 4: Run, confirm pass**

Run: `yarn test:dom --grep "Replace posts replace-session"`
Expected: PASS.

- [ ] **Step 5: Detector, lint, types, commit**

```bash
node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/session-header.tsx
yarn lint && yarn check-types
git add -A
git commit -m "feat: replace-session button on the pane header"
```

---

### Task 14: Full regression pass

**Files:** none new — verification only.

- [ ] **Step 1: Full unit suite**

Run: `yarn test:unit`
Expected: PASS, zero failures, zero skips introduced by this plan.

- [ ] **Step 2: Full DOM suite**

Run: `yarn test:dom`
Expected: PASS.

- [ ] **Step 3: Integration suite**

Run: `yarn test`
Expected: PASS. If this suite drives the actual extension host end-to-end and touches layout persistence across a simulated reload, pay particular attention to any failure here — it's the one layer nothing above exercises directly.

- [ ] **Step 4: Lint, types, compile**

Run: `yarn lint && yarn check-types && yarn run compile`
Expected: all three pass clean.

- [ ] **Step 5: Critique gate**

Per `CLAUDE.md`'s UI-changes-go-through-impeccable rule: run `critique` over `src/webview` (via the `impeccable` skill) and compare against whatever baseline already sits in `.impeccable/critique/` in this worktree. The score must not regress. This step needs the `impeccable:critique` flow (a controller run, not something an implementer subagent can self-certify — see the "Critique gate needs the controller" project memory) — flag this step for the user/controller rather than having a task-subagent mark it done unilaterally.

- [ ] **Step 6: Manual smoke pass in a real Extension Development Host**

Launch via F5 (or whatever this project's `run` skill/task does), and by hand: split a pane by dragging, apply each built-in preset, save one as custom, delete it, assign a session into an empty slot, hit Replace on a pane, reload the window and confirm the tree layout and any saved presets survive. This is the one check nothing above automates — a reload-persistence bug in the real extension host (as opposed to the migration unit test's synthetic fixture) is exactly the kind of thing only this catches.

- [ ] **Step 7: Final commit if anything above required fixes**

```bash
git add -A
git commit -m "fix: address grid-layout regression pass findings"
```

If nothing needed fixing, this step is a no-op — don't create an empty commit.

---

## Self-Review Notes

- **Spec coverage:** tree data model (Tasks 2–3), rendering (Task 8), drag-to-split (Task 9), presets built-in+apply (Task 11), save/delete custom (Task 12), empty slots (Task 8), replace-session (Tasks 5/6/13), migration (Task 4), testing conventions (every task's own unit/DOM steps + Task 14's full pass). Every section of the spec has a task.
- **Two open implementation-time decisions flagged inline rather than left ambiguous:** (1) `layout-tree.ts`'s final location (`src/webview/components/` vs `src/shared/`) is resolved by Task 5 Step 1's own grep-and-decide, not left to guesswork; (2) the save-preset naming UI's exact dialog primitive is resolved by Task 11 Step 7's own check against existing vendored components. Both are implementation-detail decisions with a clear, checkable resolution procedure, not design ambiguity — the design doc's decisions themselves have no gaps.
- **Type consistency check:** `LayoutNode`/`PaneLayout`/`LayoutPreset` (Task 1) are used identically in every later task — `layout-tree.ts` mirrors `LayoutNode` structurally (Task 2, same convention `pane-layout.ts` already used pre-tree), `pane-layout.ts` imports the real types where it needs `PaneLayout`-adjacent shapes (Task 3), host and webview agree on `PaneLayout = {root, presets}` throughout (Tasks 4–6), and every function signature introduced in Task 2 (`splitAt`, `assignAt`, `removeSession`, `replaceLeafSession`, `fillShape`, `stripSessionIds`, `findPath`, `flattenLeaves`, `leafSessionIds`, `slotCount`, plus `at`/`replaceAt` exported in Task 8) is called with matching names and argument order in every later task that uses it.
