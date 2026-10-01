# TUI multi-session (phase C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show several sessions at once in resizable split panes with a persisted layout, mouse support, fork and handoff, and a defined meaning of "visible" that survives `marcode__spawn_session`.

**Architecture:** The layout (`PaneLayout`) is the source of truth for the visible set. Pure geometry computes pane and divider rectangles from the tree and the terminal size; the TUI positions each pane absolutely from those rectangles, so rendering and mouse hit-testing share one calculation. A store hook mirrors the webview's `reconcilePaneLayout` to place arriving sessions, and posts `set-layout`, `set-visible` and `focus-pane`. The host is unchanged.

**Tech Stack:** TypeScript, React 19, OpenTUI (`@opentui/react`), Bun (`bun test`), mocha for pure logic.

**Spec:** `docs/superpowers/specs/2026-10-01-tui-multi-session-design.md`

## Global Constraints

- Nothing under `src/tui/` or `src/client-core/` imports `vscode`; `src/client-core/` has no React or DOM.
- `src/protocol/messages.ts` stays types-only and is not edited.
- Filenames are kebab-case; keep files under about 300 lines (`app.tsx` must shrink, not grow).
- Comments only for a non-obvious why; never more comment than code.
- Every session-addressed message carries a `SessionId`.
- Errors are state, never exceptions: a stale path or drag is a no-op.
- Tests never pass a renderer or renderable to an assertion (`scripts/check-tui-asserts.mjs`); compare strings, booleans and counts.
- A lone Esc reaches OpenTUI on a timer: tests wait about 100 ms after it (`settleEscape`).
- Gates before every commit that touches code: `yarn lint`, `yarn check-types`, `yarn check-types:tui`, `yarn test:tui`, `yarn test:unit`, `yarn run compile`. `yarn test:unit` has intermittent loopback `EACCES` and `ENOTEMPTY` flakes in `SelfControlMcpServer` and `SessionOwnership` tests: re-run before treating them as real.
- Pin every shell command with `cd /e/Efebia/hiiiid-code &&`. Work on branch `feat/tui-multi-session`; do not touch master.
- Conventional commits, no Claude/Anthropic trailer. Use Write or Edit (not shell heredocs) for files with backslashes or quotes.
- No change under `src/webview/components/` except the one-line re-export in Task 1 (so the impeccable detector is not needed; if that changes, run it).

## Review Focus

1. **A pane's session leaves the roster while it is focused** (deleted elsewhere, closed by an agent): focus must fall to a remaining leaf, else a roster neighbour, else the empty state, never stay on a ghost. Pinned in Task 5.
2. **Terminal too small for the tree, or resized across the threshold mid-session**: no overlap, no zero-size pane, no crash; the focused pane stays usable. Pinned in Task 6.
3. **A spawned session arrives while a dialog is open or another pane has a pending approval**: it gets a leaf without stealing focus or answering anything. Pinned in Task 5.
4. **Divider drag released outside the pane pair, or after the layout changed under the drag**: sizes clamp, stale path is a no-op, exactly one `set-layout`. Pinned in Tasks 3 and 8.
5. **Foreign (read-only) session in a pane**: no composer input, no fork, no hide-by-chord crash; the banner shows. Pinned in Tasks 6 and 9.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/client-core/pane-layout.ts` | create (moved) | `reconcilePaneLayout`, `rosterSessionIds`, `leafDisplayState`, `visibleLeaves`, `accessibleTitles` etc., unchanged |
| `src/webview/components/pane-layout.ts` | replace with re-export | `export * from '../../client-core/pane-layout';` |
| `src/client-core/pane-geometry.ts` | create | rects, dividers, neighbour lookup, min-size check, divider hit-test |
| `src/client-core/pane-resize.ts` | create | divider move, drag, even sizes, resize-focused |
| `src/client-core/pane-ops.ts` | create | `splitAtSession` (split the leaf holding a session, new session after it) |
| `src/tui/view/pane-keys.ts` | create | `Ctrl+W` chord state machine |
| `src/tui/keymap.ts` | modify | `Action` gains `pane-prefix`, `fork-item`, `roster-handoff`; `KeyInput.sequence?` |
| `src/tui/ui/use-pane-layout.ts` | create | store glue: place/focus/hide/split, reconcile arrivals, post `set-layout`/`set-visible`/`focus-pane` |
| `src/tui/ui/store.tsx` | modify | `focus(id)` = focus only (no single-leaf layout) |
| `src/tui/ui/use-focus-fallback.ts` | modify | prefer a remaining leaf, else place a roster neighbour |
| `src/tui/ui/pane-tree.tsx`, `pane.tsx`, `pane-title.tsx`, `divider.tsx` | create | rendering and mouse |
| `src/tui/ui/use-pane-chords.ts` | create | binds `pane-keys` to layout operations |
| `src/tui/ui/app.tsx` | modify | body becomes `PaneTree`; dialogs unchanged |
| `src/tui/ui/roster.tsx`, `src/tui/view/roster-rows.ts` | modify | leaf marker, `+` badge, click, `H` |
| `src/tui/ui/transcript/transcript.tsx` | modify | `f` forks the selected message |
| `src/tui/ui/new-session-dialog.tsx`, `status-line.tsx` | modify | handoff toggle and seed line; "Summarizing" |
| `docs/tui.md`, `docs/superpowers/roadmap-tui.md` | modify | keys, mouse, smoke list; mark C landed |
| Tests | create | `src/test/unit/tui-pane-geometry.test.ts`, `tui-pane-resize.test.ts`, `tui-pane-keys.test.ts`; `src/test/tui/panes.test.tsx`, `panes-mouse.test.tsx`, `fork-handoff.test.tsx`, `e2e-panes.test.tsx` |

**Orientation convention** (from `layout-tree.gridLayout`): a `horizontal` split lays children side by side; a `vertical` split stacks them. Sizes are percentages that need not sum to exactly 100.

---

### Task 1: Move `pane-layout` into `client-core`

**Files:**
- Create: `src/client-core/pane-layout.ts` (content moved from `src/webview/components/pane-layout.ts`)
- Modify: `src/webview/components/pane-layout.ts`
- Test: existing `src/test/unit/pane-layout.test.ts` (unchanged, proves the re-export)

**Interfaces:**
- Produces: `src/client-core/pane-layout.ts` exports exactly what the webview file exported today (`reconcilePaneLayout(root, roster, snapshotArrivedIds, knownSessionIds, focusedSessionId?) -> { root: LayoutNode | null; knownSessionIds: Set<string> }`, `rosterSessionIds`, etc.).

- [ ] **Step 1: Move the file**

```bash
cd /e/Efebia/hiiiid-code && git mv src/webview/components/pane-layout.ts src/client-core/pane-layout.ts
```

- [ ] **Step 2: Fix its import and add the re-export**

In `src/client-core/pane-layout.ts` change the import from `'./layout-tree'` (it already reads `./layout-tree`, which now resolves to `client-core/layout-tree`, so it needs no edit). Then create `src/webview/components/pane-layout.ts` with exactly:

```ts
export * from '../../client-core/pane-layout';
```

- [ ] **Step 3: Run the existing tests**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit`
Expected: PASS (`pane-layout.test.ts` imports through the old path).

- [ ] **Step 4: Gates and commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui
git add -A src/client-core/pane-layout.ts src/webview/components/pane-layout.ts
git commit -m "refactor: move pane-layout into client-core so the TUI can reuse reconcile"
```

---

### Task 2: Pane geometry (pure)

**Files:**
- Create: `src/client-core/pane-geometry.ts`
- Test: `src/test/unit/tui-pane-geometry.test.ts`

**Interfaces:**
- Consumes: `LayoutNode` from `./layout-tree`.
- Produces:

```ts
export interface Rect { x: number; y: number; w: number; h: number }
export interface PaneRect extends Rect { sessionId: string | null; path: number[] }
export interface DividerRect extends Rect {
  path: number[];                       // path of the split that owns it
  index: number;                        // sits between children index and index+1
  axis: 'x' | 'y';                      // 'x': a vertical line (side-by-side split); 'y': a horizontal line (stacked)
  pairStart: number;                    // cell offset (along axis) where child `index` starts
  pairLength: number;                   // cells of child index + child index+1 (divider excluded)
}
export const MIN_PANE_W = 40;
export const MIN_PANE_H = 8;
export function layoutRects(root: LayoutNode, area: Rect): { panes: PaneRect[]; dividers: DividerRect[] };
export function neighbour(panes: PaneRect[], from: string, dir: 'left' | 'right' | 'up' | 'down'): string | undefined;
export function hitDivider(dividers: DividerRect[], x: number, y: number): DividerRect | undefined;
export function hitPane(panes: PaneRect[], x: number, y: number): PaneRect | undefined;
export function tooSmall(panes: PaneRect[]): boolean; // any occupied pane under MIN_PANE_W x MIN_PANE_H
```

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'node:assert';
import type { LayoutNode } from '../../client-core/layout-tree';
import { hitDivider, hitPane, layoutRects, neighbour, tooSmall } from '../../client-core/pane-geometry';

const leaf = (sessionId: string | null, size = 50): LayoutNode => ({ kind: 'leaf', sessionId, size });
const side = (...c: LayoutNode[]): LayoutNode => ({ kind: 'split', orientation: 'horizontal', size: 100, children: c });
const stack = (...c: LayoutNode[]): LayoutNode => ({ kind: 'split', orientation: 'vertical', size: 100, children: c });
const area = { x: 0, y: 0, w: 101, h: 30 };

suite('tui pane geometry', () => {
  test('a root leaf fills the area', () => {
    const { panes, dividers } = layoutRects(leaf('a', 100), area);
    assert.deepStrictEqual(panes, [{ sessionId: 'a', path: [], x: 0, y: 0, w: 101, h: 30 }]);
    assert.strictEqual(dividers.length, 0);
  });
  test('a side-by-side split gives each child its share and leaves one column for the divider', () => {
    const { panes, dividers } = layoutRects(side(leaf('a'), leaf('b')), area);
    assert.deepStrictEqual(panes.map((p) => [p.x, p.w]), [[0, 50], [51, 50]]);
    assert.deepStrictEqual(dividers.map((d) => [d.x, d.y, d.w, d.h, d.axis, d.pairStart, d.pairLength]), [[50, 0, 1, 30, 'x', 0, 100]]);
  });
  test('a stacked split divides rows', () => {
    const { panes, dividers } = layoutRects(stack(leaf('a'), leaf('b')), { x: 0, y: 0, w: 80, h: 21 });
    assert.deepStrictEqual(panes.map((p) => [p.y, p.h]), [[0, 10], [11, 10]]);
    assert.strictEqual(dividers[0].axis, 'y');
    assert.strictEqual(dividers[0].y, 10);
  });
  test('sizes that do not sum to 100 are normalised and every cell is used', () => {
    const { panes } = layoutRects(side(leaf('a', 30), leaf('b', 30)), area);
    assert.strictEqual(panes[0].w + 1 + panes[1].w, 101);
  });
  test('nested splits recurse with their own paths', () => {
    const { panes } = layoutRects(side(leaf('a'), stack(leaf('b'), leaf('c'))), area);
    assert.deepStrictEqual(panes.map((p) => p.path), [[0], [1, 0], [1, 1]]);
  });
  test('neighbour picks the pane across the shared edge, by the focused pane centre', () => {
    const { panes } = layoutRects(side(leaf('a'), stack(leaf('b'), leaf('c'))), area);
    assert.strictEqual(neighbour(panes, 'a', 'right'), 'b');
    assert.strictEqual(neighbour(panes, 'b', 'down'), 'c');
    assert.strictEqual(neighbour(panes, 'c', 'left'), 'a');
    assert.strictEqual(neighbour(panes, 'a', 'left'), undefined);
    assert.strictEqual(neighbour(panes, 'zzz', 'right'), undefined);
  });
  test('empty leaves are never a neighbour target', () => {
    const { panes } = layoutRects(side(leaf('a'), leaf(null)), area);
    assert.strictEqual(neighbour(panes, 'a', 'right'), undefined);
  });
  test('hit tests', () => {
    const { panes, dividers } = layoutRects(side(leaf('a'), leaf('b')), area);
    assert.strictEqual(hitPane(panes, 10, 5)?.sessionId, 'a');
    assert.strictEqual(hitPane(panes, 80, 5)?.sessionId, 'b');
    assert.strictEqual(hitPane(panes, 50, 5), undefined);
    assert.strictEqual(hitDivider(dividers, 50, 5)?.index, 0);
    assert.strictEqual(hitDivider(dividers, 49, 5), undefined);
  });
  test('tooSmall flags an occupied pane under the minimum and ignores empty leaves', () => {
    assert.strictEqual(tooSmall(layoutRects(side(leaf('a'), leaf('b')), { x: 0, y: 0, w: 70, h: 30 }).panes), true);
    assert.strictEqual(tooSmall(layoutRects(side(leaf('a'), leaf('b')), { x: 0, y: 0, w: 101, h: 30 }).panes), false);
    assert.strictEqual(tooSmall(layoutRects(side(leaf('a'), leaf(null)), { x: 0, y: 0, w: 50, h: 30 }).panes), false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit`
Expected: FAIL, cannot find module `pane-geometry`.

- [ ] **Step 3: Implement**

```ts
import type { LayoutNode } from './layout-tree';

export interface Rect { x: number; y: number; w: number; h: number }
export interface PaneRect extends Rect { sessionId: string | null; path: number[] }
export interface DividerRect extends Rect {
  path: number[]; index: number; axis: 'x' | 'y'; pairStart: number; pairLength: number;
}

export const MIN_PANE_W = 40;
export const MIN_PANE_H = 8;

function shares(sizes: number[], total: number): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0) || 1;
  const out = sizes.map((s) => Math.max(1, Math.floor((s / sum) * total)));
  out[out.length - 1] = Math.max(1, total - out.slice(0, -1).reduce((a, b) => a + b, 0));
  return out;
}

export function layoutRects(root: LayoutNode, area: Rect): { panes: PaneRect[]; dividers: DividerRect[] } {
  const panes: PaneRect[] = [];
  const dividers: DividerRect[] = [];
  const walk = (node: LayoutNode, r: Rect, path: number[]) => {
    if (node.kind === 'leaf') { panes.push({ ...r, sessionId: node.sessionId, path }); return; }
    const side = node.orientation === 'horizontal';
    const n = node.children.length;
    const total = Math.max(n, (side ? r.w : r.h) - (n - 1));
    const lens = shares(node.children.map((c) => c.size), total);
    let at = side ? r.x : r.y;
    node.children.forEach((child, i) => {
      const len = lens[i];
      walk(child, side ? { x: at, y: r.y, w: len, h: r.h } : { x: r.x, y: at, w: r.w, h: len }, [...path, i]);
      at += len;
      if (i < n - 1) {
        const pairStart = at - len;
        dividers.push({
          path, index: i, axis: side ? 'x' : 'y', pairStart, pairLength: len + lens[i + 1],
          ...(side ? { x: at, y: r.y, w: 1, h: r.h } : { x: r.x, y: at, w: r.w, h: 1 }),
        });
        at += 1;
      }
    });
  };
  walk(root, area, []);
  return { panes, dividers };
}

const inside = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

export function hitPane(panes: PaneRect[], x: number, y: number): PaneRect | undefined {
  return panes.find((p) => inside(p, x, y));
}

export function hitDivider(dividers: DividerRect[], x: number, y: number): DividerRect | undefined {
  return dividers.find((d) => inside(d, x, y));
}

export function neighbour(
  panes: PaneRect[], from: string, dir: 'left' | 'right' | 'up' | 'down',
): string | undefined {
  const f = panes.find((p) => p.sessionId === from);
  if (!f) { return undefined; }
  const cx = f.x + Math.floor(f.w / 2);
  const cy = f.y + Math.floor(f.h / 2);
  const candidates = panes
    .filter((p): p is PaneRect & { sessionId: string } => p.sessionId !== null && p.sessionId !== from)
    .filter((p) => {
      switch (dir) {
        case 'right': return p.x >= f.x + f.w && cy >= p.y && cy < p.y + p.h;
        case 'left': return p.x + p.w <= f.x && cy >= p.y && cy < p.y + p.h;
        case 'down': return p.y >= f.y + f.h && cx >= p.x && cx < p.x + p.w;
        case 'up': return p.y + p.h <= f.y && cx >= p.x && cx < p.x + p.w;
      }
    });
  const gap = (p: PaneRect) => (dir === 'right' ? p.x - (f.x + f.w) : dir === 'left' ? f.x - (p.x + p.w)
    : dir === 'down' ? p.y - (f.y + f.h) : f.y - (p.y + p.h));
  return candidates.sort((a, b) => gap(a) - gap(b))[0]?.sessionId;
}

export function tooSmall(panes: PaneRect[]): boolean {
  return panes.some((p) => p.sessionId !== null && (p.w < MIN_PANE_W || p.h < MIN_PANE_H));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit`
Expected: PASS. If the `[0, 50], [51, 50]` expectation is off by one because of floor, fix the test arithmetic to match `shares` (the last child takes the remainder), not the other way round.

- [ ] **Step 5: Gates and commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui
git add src/client-core/pane-geometry.ts src/test/unit/tui-pane-geometry.test.ts
git commit -m "feat: pure pane geometry for the TUI (rects, dividers, neighbours, hit tests)"
```

---

### Task 3: Pane resize and split ops (pure)

**Files:**
- Create: `src/client-core/pane-resize.ts`, `src/client-core/pane-ops.ts`
- Test: `src/test/unit/tui-pane-resize.test.ts`

**Interfaces:**
- Consumes: `LayoutNode`, `at`, `replaceAt`, `findPath` from `./layout-tree`; `DividerRect` from `./pane-geometry`.
- Produces:

```ts
export const MIN_SHARE = 8; // percent a pane can be dragged down to
export function dragDivider(root: LayoutNode, d: DividerRect, pointer: number): LayoutNode; // pointer = x for axis 'x', y for 'y'
export function nudgeDivider(root: LayoutNode, splitPath: number[], index: number, deltaPct: number): LayoutNode;
export function evenAll(root: LayoutNode): LayoutNode;
export function nudgeFocused(root: LayoutNode, sessionId: string, dir: 'left'|'right'|'up'|'down', pct: number): LayoutNode;
// pane-ops.ts
export function splitAtSession(root: LayoutNode, focusedId: string | null, orientation: 'vertical' | 'horizontal', newId: string): LayoutNode;
```

Every function returns `root` unchanged for a stale path or unknown session (no throw).

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'node:assert';
import type { LayoutNode } from '../../client-core/layout-tree';
import { layoutRects } from '../../client-core/pane-geometry';
import { splitAtSession } from '../../client-core/pane-ops';
import { dragDivider, evenAll, MIN_SHARE, nudgeDivider, nudgeFocused } from '../../client-core/pane-resize';

const leaf = (id: string | null, size = 50): LayoutNode => ({ kind: 'leaf', sessionId: id, size });
const side = (...c: LayoutNode[]): LayoutNode => ({ kind: 'split', orientation: 'horizontal', size: 100, children: c });
const sizes = (n: LayoutNode) => (n.kind === 'split' ? n.children.map((c) => Math.round(c.size)) : []);
const area = { x: 0, y: 0, w: 101, h: 30 };

suite('tui pane resize', () => {
  test('dragging a divider moves the boundary and keeps the pair total', () => {
    const root = side(leaf('a'), leaf('b'));
    const d = layoutRects(root, area).dividers[0];
    assert.deepStrictEqual(sizes(dragDivider(root, d, 25)), [25, 75]);
  });
  test('a drag past either end clamps to the minimum share', () => {
    const root = side(leaf('a'), leaf('b'));
    const d = layoutRects(root, area).dividers[0];
    assert.deepStrictEqual(sizes(dragDivider(root, d, -40)), [MIN_SHARE, 100 - MIN_SHARE]);
    assert.deepStrictEqual(sizes(dragDivider(root, d, 400)), [100 - MIN_SHARE, MIN_SHARE]);
  });
  test('a drag only moves its own pair in a three-way split', () => {
    const root = side(leaf('a', 34), leaf('b', 33), leaf('c', 33));
    const d = layoutRects(root, area).dividers[1];
    const next = dragDivider(root, d, 80);
    assert.strictEqual(Math.round((next as Extract<LayoutNode, { kind: 'split' }>).children[0].size), 34);
  });
  test('a stale divider path is a no-op', () => {
    const root = side(leaf('a'), leaf('b'));
    assert.strictEqual(nudgeDivider(root, [7], 0, 5), root);
    assert.strictEqual(nudgeDivider(root, [], 9, 5), root);
  });
  test('nudgeFocused grows the pane toward its direction and is a no-op without a split on that axis', () => {
    const root = side(leaf('a'), leaf('b'));
    assert.deepStrictEqual(sizes(nudgeFocused(root, 'a', 'right', 5)), [55, 45]);
    assert.deepStrictEqual(sizes(nudgeFocused(root, 'b', 'left', 5)), [45, 55]);
    assert.strictEqual(nudgeFocused(root, 'a', 'down', 5), root);
    assert.strictEqual(nudgeFocused(root, 'nobody', 'right', 5), root);
  });
  test('evenAll resets every split to equal shares', () => {
    assert.deepStrictEqual(sizes(evenAll(side(leaf('a', 80), leaf('b', 10), leaf('c', 10)))), [33, 33, 33]);
  });
  test('splitAtSession puts the new session after the focused one, or at the root when nothing is focused', () => {
    const split = splitAtSession(leaf('a', 100), 'a', 'horizontal', 'b');
    assert.deepStrictEqual(sizes(split), [50, 50]);
    const same = splitAtSession(leaf('a', 100), 'zzz', 'vertical', 'b');
    assert.strictEqual(same.kind, 'split');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd /e/Efebia/hiiiid-code && yarn test:unit`. Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

`src/client-core/pane-resize.ts`:

```ts
import { at, findPath, replaceAt, type LayoutNode } from './layout-tree';
import type { DividerRect } from './pane-geometry';

export const MIN_SHARE = 8;

function withPair(root: LayoutNode, splitPath: number[], index: number, a: number): LayoutNode {
  const split = at(root, splitPath);
  if (split?.kind !== 'split' || !split.children[index] || !split.children[index + 1]) { return root; }
  const total = split.children[index].size + split.children[index + 1].size;
  const first = Math.min(total - MIN_SHARE, Math.max(MIN_SHARE, a));
  return replaceAt(root, splitPath, {
    ...split,
    children: split.children.map((c, i) => (i === index ? { ...c, size: first } : i === index + 1 ? { ...c, size: total - first } : c)),
  });
}

export function dragDivider(root: LayoutNode, d: DividerRect, pointer: number): LayoutNode {
  const split = at(root, d.path);
  if (split?.kind !== 'split' || !split.children[d.index] || !split.children[d.index + 1]) { return root; }
  const total = split.children[d.index].size + split.children[d.index + 1].size;
  const fraction = (pointer - d.pairStart) / Math.max(1, d.pairLength);
  return withPair(root, d.path, d.index, fraction * total);
}

export function nudgeDivider(root: LayoutNode, splitPath: number[], index: number, deltaPct: number): LayoutNode {
  const split = at(root, splitPath);
  if (split?.kind !== 'split' || !split.children[index]) { return root; }
  return withPair(root, splitPath, index, split.children[index].size + deltaPct);
}

export function evenAll(root: LayoutNode): LayoutNode {
  if (root.kind === 'leaf') { return root; }
  const each = 100 / root.children.length;
  return { ...root, children: root.children.map((c) => ({ ...evenAll(c), size: each })) };
}

export function nudgeFocused(
  root: LayoutNode, sessionId: string, dir: 'left' | 'right' | 'up' | 'down', pct: number,
): LayoutNode {
  const path = findPath(root, sessionId);
  if (path === undefined) { return root; }
  const wantOrientation = dir === 'left' || dir === 'right' ? 'horizontal' : 'vertical';
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const splitPath = path.slice(0, depth);
    const split = at(root, splitPath);
    if (split?.kind !== 'split' || split.orientation !== wantOrientation) { continue; }
    const i = path[depth];
    const grow = dir === 'right' || dir === 'down';
    const boundary = grow ? i : i - 1;
    if (boundary < 0 || boundary >= split.children.length - 1) { continue; }
    return nudgeDivider(root, splitPath, boundary, grow ? pct : -pct);
  }
  return root;
}
```

`src/client-core/pane-ops.ts`:

```ts
import { findPath, splitAt, type LayoutNode } from './layout-tree';

export function splitAtSession(
  root: LayoutNode, focusedId: string | null, orientation: 'vertical' | 'horizontal', newId: string,
): LayoutNode {
  const path = (focusedId ? findPath(root, focusedId) : undefined) ?? [];
  return splitAt(root, path, orientation, newId);
}
```

For `nudgeFocused('b','left',5)` on `[a,b]`: `grow` false, `boundary = 0`, delta `-5` moves the first child down, so b grows to 55. For `('a','right',5)`: boundary 0, +5, a becomes 55. Both match the test.

- [ ] **Step 4: Run to verify it passes** — `cd /e/Efebia/hiiiid-code && yarn test:unit`. Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui
git add src/client-core/pane-resize.ts src/client-core/pane-ops.ts src/test/unit/tui-pane-resize.test.ts
git commit -m "feat: pure pane resize and split helpers for the TUI"
```

---

### Task 4: `Ctrl+W` chord state machine and keymap actions

**Files:**
- Create: `src/tui/view/pane-keys.ts`
- Modify: `src/tui/keymap.ts` (add `sequence?` to `KeyInput`; add `{ do: 'pane-prefix' }`, `{ do: 'fork-item' }`, `{ do: 'roster-handoff' }` to `Action`; `Ctrl+W` is global; `f` in transcript; `H` (shift+h) in roster)
- Test: `src/test/unit/tui-pane-keys.test.ts`, extend `src/test/unit/tui-keymap.test.ts`

**Interfaces:**
- Consumes: `KeyInput` from `../keymap`.
- Produces:

```ts
export type Dir = 'left' | 'right' | 'up' | 'down';
export type PaneAction =
  | { do: 'focus'; dir: Dir } | { do: 'split'; orientation: 'horizontal' | 'vertical' }
  | { do: 'maximize' } | { do: 'even' } | { do: 'resize'; dir: Dir } | { do: 'hide' };
export const CHORD_MS = 1500;
export interface ChordResult { armedAt: number | null; consumed: boolean; action?: PaneAction }
export function chordStep(armedAt: number | null, now: number, key: KeyInput): ChordResult;
```

Behaviour: when `armedAt === null`, only `Ctrl+W` arms (`consumed: true`); every other key returns `consumed: false, armedAt: null`. When armed and `now - armedAt <= CHORD_MS`: `h j k l` and arrows focus; `|` split horizontal; `-` split vertical; `m`; `=`; `H J K L` resize; `x` hide. Escape or any unknown key disarms and is consumed. An expired arm behaves as unarmed (and that key is not consumed). The key's glyph is `key.sequence ?? key.name`, shifted letters (`key.shift` with a single-letter name) are upper-cased.

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'node:assert';
import { CHORD_MS, chordStep } from '../../tui/view/pane-keys';

const ctrlW = { name: 'w', ctrl: true };

suite('tui pane chords', () => {
  test('Ctrl+W arms and is consumed; other keys pass through when unarmed', () => {
    assert.deepStrictEqual(chordStep(null, 100, ctrlW), { armedAt: 100, consumed: true });
    assert.deepStrictEqual(chordStep(null, 100, { name: 'h' }), { armedAt: null, consumed: false });
  });
  test('direction keys and arrows focus', () => {
    assert.deepStrictEqual(chordStep(100, 200, { name: 'h' }), { armedAt: null, consumed: true, action: { do: 'focus', dir: 'left' } });
    assert.deepStrictEqual(chordStep(100, 200, { name: 'down' }).action, { do: 'focus', dir: 'down' });
  });
  test('split, maximize, even, hide', () => {
    assert.deepStrictEqual(chordStep(100, 200, { name: '|', sequence: '|' }).action, { do: 'split', orientation: 'horizontal' });
    assert.deepStrictEqual(chordStep(100, 200, { name: '-', sequence: '-' }).action, { do: 'split', orientation: 'vertical' });
    assert.deepStrictEqual(chordStep(100, 200, { name: 'm' }).action, { do: 'maximize' });
    assert.deepStrictEqual(chordStep(100, 200, { name: '=', sequence: '=' }).action, { do: 'even' });
    assert.deepStrictEqual(chordStep(100, 200, { name: 'x' }).action, { do: 'hide' });
  });
  test('shifted letters resize', () => {
    assert.deepStrictEqual(chordStep(100, 200, { name: 'l', shift: true }).action, { do: 'resize', dir: 'right' });
    assert.deepStrictEqual(chordStep(100, 200, { name: 'k', shift: true }).action, { do: 'resize', dir: 'up' });
  });
  test('Esc and unknown keys disarm and are swallowed', () => {
    assert.deepStrictEqual(chordStep(100, 200, { name: 'escape' }), { armedAt: null, consumed: true });
    assert.deepStrictEqual(chordStep(100, 200, { name: 'q' }), { armedAt: null, consumed: true });
  });
  test('an expired arm is ignored and the key passes through', () => {
    assert.deepStrictEqual(chordStep(100, 100 + CHORD_MS + 1, { name: 'h' }), { armedAt: null, consumed: false });
  });
  test('Ctrl+W while armed re-arms', () => {
    assert.deepStrictEqual(chordStep(100, 200, ctrlW), { armedAt: 200, consumed: true });
  });
});
```

Add to `tui-keymap.test.ts`:

```ts
  test('Ctrl+W is the pane prefix everywhere; f forks in the transcript; Shift+H hands off from the roster', () => {
    for (const zone of ['composer', 'transcript', 'roster'] as const) {
      assert.deepStrictEqual(actionFor(zone, { name: 'w', ctrl: true }, idle), { do: 'pane-prefix' });
    }
    assert.deepStrictEqual(actionFor('transcript', { name: 'f' }, idle), { do: 'fork-item' });
    assert.strictEqual(actionFor('composer', { name: 'f' }, idle), undefined);
    assert.deepStrictEqual(actionFor('roster', { name: 'h', shift: true }, idle), { do: 'roster-handoff' });
    assert.strictEqual(actionFor('roster', { name: 'h' }, idle), undefined);
  });
```

- [ ] **Step 2: Run to verify it fails** — `cd /e/Efebia/hiiiid-code && yarn test:unit`. Expected: FAIL.

- [ ] **Step 3: Implement**

`src/tui/view/pane-keys.ts`:

```ts
import type { KeyInput } from '../keymap';

export type Dir = 'left' | 'right' | 'up' | 'down';
export type PaneAction =
  | { do: 'focus'; dir: Dir } | { do: 'split'; orientation: 'horizontal' | 'vertical' }
  | { do: 'maximize' } | { do: 'even' } | { do: 'resize'; dir: Dir } | { do: 'hide' };
export interface ChordResult { armedAt: number | null; consumed: boolean; action?: PaneAction }

export const CHORD_MS = 1500;

const FOCUS: Record<string, Dir> = { h: 'left', j: 'down', k: 'up', l: 'right', left: 'left', down: 'down', up: 'up', right: 'right' };
const RESIZE: Record<string, Dir> = { H: 'left', J: 'down', K: 'up', L: 'right' };

const isPrefix = (k: KeyInput) => k.ctrl === true && k.name === 'w';

function chordAction(key: KeyInput): PaneAction | undefined {
  const glyph = key.sequence ?? key.name;
  if (glyph === '|') { return { do: 'split', orientation: 'horizontal' }; }
  if (glyph === '-') { return { do: 'split', orientation: 'vertical' }; }
  if (glyph === '=') { return { do: 'even' }; }
  const letter = key.shift && key.name.length === 1 ? key.name.toUpperCase() : key.name;
  const resize = RESIZE[letter];
  if (resize) { return { do: 'resize', dir: resize }; }
  if (key.name === 'm') { return { do: 'maximize' }; }
  if (key.name === 'x') { return { do: 'hide' }; }
  const focus = FOCUS[key.name];
  return focus ? { do: 'focus', dir: focus } : undefined;
}

export function chordStep(armedAt: number | null, now: number, key: KeyInput): ChordResult {
  const live = armedAt !== null && now - armedAt <= CHORD_MS;
  if (isPrefix(key)) { return { armedAt: now, consumed: true }; }
  if (!live) { return { armedAt: null, consumed: false }; }
  const action = chordAction(key);
  return action ? { armedAt: null, consumed: true, action } : { armedAt: null, consumed: true };
}
```

`keymap.ts`: add `sequence?: string` to `KeyInput`; extend `Action` with `| { do: 'pane-prefix' } | { do: 'fork-item' } | { do: 'roster-handoff' }`; in `globalAction`'s ctrl switch add `case 'w': return act('pane-prefix');`; in transcript switch add `case 'f': return act('fork-item');`; in roster switch add `case 'h': return key.shift ? act('roster-handoff') : undefined;`.

- [ ] **Step 4: Run to verify it passes** — `cd /e/Efebia/hiiiid-code && yarn test:unit`. Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui
git add src/tui/view/pane-keys.ts src/tui/keymap.ts src/test/unit/tui-pane-keys.test.ts src/test/unit/tui-keymap.test.ts
git commit -m "feat: Ctrl+W pane chord state machine and keymap actions"
```

---

### Task 5: Layout-owned visible set (store glue, spawn fix)

**Files:**
- Create: `src/tui/ui/use-pane-layout.ts`
- Modify: `src/tui/ui/store.tsx`, `src/tui/ui/use-focus-fallback.ts`, `src/tui/ui/app.tsx`, `src/tui/view/roster-rows.ts`, `src/tui/ui/roster.tsx`
- Test: `src/test/tui/panes.test.tsx` (new), update `src/test/tui/app.test.tsx` (the "single-leaf visible set" test and the focus test), `src/test/unit/tui-view.test.ts` (roster row markers)

**Interfaces:**
- Consumes: `reconcilePaneLayout`, `rosterSessionIds` (`client-core/pane-layout`); `placeSession`, `removeSession`, `leafSessionIds`, `findPath`, `rootOrientation` (`client-core/layout-tree`); `splitAtSession` (`pane-ops`).
- Produces (`use-pane-layout.ts`):

```ts
export interface PaneLayoutApi {
  root: LayoutNode;                                  // state.layout.root
  leafIds: SessionId[];
  placeOrFocus(id: SessionId): void;                 // has a leaf: focus; else placeSession and post
  hide(id: SessionId): void;                         // removeSession, post set-layout + set-visible
  armSplit(orientation: 'horizontal' | 'vertical'): void; // the next created/forked arrival splits the focused leaf
  applyRoot(root: LayoutNode): void;                 // post set-layout + local-layout (resize, even)
  expectArrival(): void;                             // the next unknown session id is user-initiated: focus it
}
export function usePaneLayout(): PaneLayoutApi;
```

`TuiStoreValue.focus(id)` now only does `focus-pane` + `local-focus`; it posts no layout. `RosterRow` gains `leaf: boolean`, `overflow: boolean` is computed in the component (needs geometry) and passed as a prop, so the view-model takes `leafIds: ReadonlySet<SessionId>` as a new fourth parameter: `rosterRows(sessions, focusedId, filter, leafIds)`; the row text shows `▪` for a leaf and the `+` badge is added in Task 6.

Behaviour of `usePaneLayout` (called once, in `App`):

1. **Reconcile effect** (same shape as `src/webview/app.tsx` lines 47-78, without the pending-slot part): keyed on `Object.keys(state.byId).join(',')`, the roster ids and the leaf ids; call `reconcilePaneLayout(root, rosterSessionIds(state.sessions), byIdKeys, known.current, state.focusedSessionId ?? state.layout.focusedSessionId)`; store `known.current = result.knownSessionIds`; when `result.root`, call `applyRoot(result.root)`. If `armedSplit.current` is set and exactly one new id arrived, build the root with `splitAtSession(root, focusedId, orientation, id)` instead of letting reconcile place it, then clear the arm.
2. **Visible effect**: keyed on `leafIds.join(',')`, post `{ t: 'set-visible', sessionIds: leafIds }` (also once on mount after `ready`, since `hydrate` never calls `setVisible` on the host).
3. **Focus on arrival**: when `expectArrival()` was called and a new id appears, `focus(id)`. An arrival nobody asked for (a spawned session) is placed but not focused.
4. `placeOrFocus(id)`: `if (leafIds.includes(id)) { focus(id); return; }` else `applyRoot(placeSession(root, id, focusedId, rootOrientation(root)))` then `focus(id)`.
5. `hide(id)`: `applyRoot(removeSession(root, id))`; `useFocusFallback` moves focus.
6. `applyRoot(root)`: `const layout = { ...state.layout, root }; post({ t: 'set-layout', layout }); dispatch local-layout` (the store exposes a `dispatch`-backed `setLocalLayout(layout)`; add it to `TuiStoreValue`).

`use-focus-fallback.ts`: when the focused session was removed or hidden, the next focus target is the nearest remaining **leaf** in reading order (`leafSessionIds(root)`), else the roster neighbour via `placeOrFocus`, else abandoned (empty state). Replace its `focus` dependency with `usePaneLayout().placeOrFocus` passed in by `App` (give the hook a `placeOrFocus` argument rather than calling `usePaneLayout` twice).

- [ ] **Step 1: Write the failing tests** (`src/test/tui/panes.test.tsx`)

```tsx
import { afterEach, expect, test } from 'bun:test';
import type { LayoutNode } from '../../client-core/layout-tree';
import { App } from '../../tui/ui/app';
import { catalog, snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const props = { launchCwd: '/repo', forceNew: false, loginCommands: {}, onQuit: () => {} };
const leaf = (sessionId: string, size = 50): LayoutNode => ({ kind: 'leaf', sessionId, size });
const twoUp = (): LayoutNode => ({ kind: 'split', orientation: 'horizontal', size: 100, children: [leaf('s1'), leaf('s2')] });
const hydrateTwo = () => hydrateMsg({
  sessions: [summary('s1', { name: 'one' }), summary('s2', { name: 'two' })],
  layout: { root: twoUp(), presets: [], focusedSessionId: 's1' },
  snapshots: [snapshot('s1'), snapshot('s2')],
});
const lastSetVisible = (posted: Mounted['posted']) => [...posted].reverse().find((p) => p.t === 'set-visible');
const lastSetLayout = (posted: Mounted['posted']) => [...posted].reverse().find((p) => p.t === 'set-layout');

test('launch restores a two-pane layout and posts both leaves as the visible set', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  const v = lastSetVisible(m.posted);
  expect(v?.t === 'set-visible' && v.sessionIds.join(',')).toBe('s1,s2');
});

test('a session arriving by snapshot with no leaf (a spawn) is placed in a pane and not focused', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg());
  await m.fromHost(
    { t: 'sessions-changed', sessions: [summary('s1'), summary('sp1', { name: 'spawned' })] },
    { t: 'session-snapshot', session: snapshot('sp1') },
  );
  const l = lastSetLayout(m.posted);
  expect(l?.t === 'set-layout' && JSON.stringify(l.layout.root).includes('"sp1"')).toBe(true);
  const v = lastSetVisible(m.posted);
  expect(v?.t === 'set-visible' && v.sessionIds.includes('sp1')).toBe(true);
  const focuses = m.posted.filter((p) => p.t === 'focus-pane' && p.sessionId === 'sp1');
  expect(focuses.length).toBe(0);
});

test('a hidden session is not re-placed when its snapshot arrives again', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await m.press('w', { ctrl: true });
  await m.press('x');
  const before = m.posted.filter((p) => p.t === 'set-layout').length;
  await m.fromHost({ t: 'session-snapshot', session: snapshot('s1') });
  expect(m.posted.filter((p) => p.t === 'set-layout').length).toBe(before);
});

test('roster Enter on an unshown session places it; on a shown one only moves focus', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { name: 'one' }), summary('s2', { name: 'two' })] }));
  await m.press('b', { ctrl: true }); await m.press('b', { ctrl: true });
  await m.press('tab'); await m.press('tab');
  await m.press('j'); await m.press('return');
  const l = lastSetLayout(m.posted);
  expect(l?.t === 'set-layout' && JSON.stringify(l.layout.root).includes('"s2"')).toBe(true);
});

test('when the focused session is deleted, focus falls to a remaining leaf', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await m.fromHost({ t: 'sessions-changed', sessions: [summary('s2', { name: 'two' })] });
  const focuses = m.posted.filter((p) => p.t === 'focus-pane');
  expect(focuses[focuses.length - 1]?.t === 'focus-pane' && focuses[focuses.length - 1].sessionId).toBe('s2');
});
```

Add to `tui-view.test.ts`:

```ts
  test('roster rows mark sessions that have a pane', () => {
    const rows = rosterRows([summary('a'), summary('b')], 'a', '', new Set(['a']));
    assert.deepStrictEqual(rows.map((r) => r.leaf), [true, false]);
  });
```

Update `app.test.tsx`: rename the first test to "resumes the last session and posts its leaf as the visible set" (assertion unchanged: a one-leaf layout posts `[s1]`); in the Ctrl+B test, an unshown session placed from the roster now posts `set-layout` containing both ids and `set-visible` with both ids; adjust its assertion to `sessionIds.includes('s2')`.

- [ ] **Step 2: Run to verify it fails** — `cd /e/Efebia/hiiiid-code && yarn test:tui` and `yarn test:unit`. Expected: new tests FAIL; the edited ones FAIL until the implementation lands.

- [ ] **Step 3: Implement**

`store.tsx`: change `focus` to

```ts
const focus = useCallback((id: SessionId) => {
  transport.post({ t: 'focus-pane', sessionId: id });
  dispatch({ t: 'local-focus', id });
}, [transport]);
```

and add `setLocalLayout(layout: PaneLayout): void` to the value (`dispatch({ t: 'local-layout', layout })`).

`use-pane-layout.ts` (sketch complete; keep under 120 lines):

```ts
import { useCallback, useEffect, useRef } from 'react';
import { findPath, leafSessionIds, placeSession, removeSession, rootOrientation, type LayoutNode } from '../../client-core/layout-tree';
import { reconcilePaneLayout, rosterSessionIds } from '../../client-core/pane-layout';
import { splitAtSession } from '../../client-core/pane-ops';
import type { PaneLayout, SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';

export interface PaneLayoutApi {
  root: LayoutNode; leafIds: SessionId[];
  placeOrFocus(id: SessionId): void; hide(id: SessionId): void;
  armSplit(orientation: 'horizontal' | 'vertical'): void;
  applyRoot(root: LayoutNode): void; expectArrival(): void;
}

export function usePaneLayout(): PaneLayoutApi {
  const { state, post, focus, focusedId, setLocalLayout } = useTuiStore();
  const root = state.layout.root;
  const leafIds = leafSessionIds(root);
  const stateRef = useRef(state); stateRef.current = state;
  const known = useRef<Set<string>>(new Set());
  const split = useRef<'horizontal' | 'vertical' | null>(null);
  const expecting = useRef(false);

  const applyRoot = useCallback((next: LayoutNode) => {
    const layout: PaneLayout = { ...stateRef.current.layout, root: next };
    post({ t: 'set-layout', layout });
    setLocalLayout(layout);
  }, [post, setLocalLayout]);

  const byIdKeys = Object.keys(state.byId);
  useEffect(() => {
    const before = known.current;
    let next = stateRef.current.layout.root;
    const arrived = byIdKeys.filter((id) => !before.has(id) && !leafIds.includes(id));
    if (split.current && arrived.length === 1 && rosterSessionIds(state.sessions).has(arrived[0])) {
      next = splitAtSession(next, focusedId, split.current, arrived[0]);
      split.current = null;
      known.current = new Set([...before, ...byIdKeys]);
      applyRoot(next);
    } else {
      const result = reconcilePaneLayout(next, rosterSessionIds(state.sessions), byIdKeys, before, focusedId ?? state.layout.focusedSessionId);
      known.current = result.knownSessionIds;
      if (result.root) { applyRoot(result.root); }
    }
    if (expecting.current && arrived.length > 0) { expecting.current = false; focus(arrived[0]); }
  }, [byIdKeys.join(','), state.sessions.map((s) => s.id).join(','), leafIds.join(',')]);

  useEffect(() => { post({ t: 'set-visible', sessionIds: leafIds }); }, [leafIds.join(',')]);

  const placeOrFocus = useCallback((id: SessionId) => {
    const cur = stateRef.current.layout.root;
    if (findPath(cur, id) === undefined) {
      applyRoot(placeSession(cur, id, stateRef.current.focusedSessionId, rootOrientation(cur)));
    }
    focus(id);
  }, [applyRoot, focus]);

  return {
    root, leafIds, placeOrFocus, applyRoot,
    hide: (id) => { applyRoot(removeSession(stateRef.current.layout.root, id)); },
    armSplit: (o) => { split.current = o; },
    expectArrival: () => { expecting.current = true; },
  };
}
```

Known-ids subtlety (spec invariant): after `hydrate`, `byId` holds only the persisted leaves, so a hidden session is absent and is never re-placed. `known` starts empty, so the first effect pass marks hydrated leaves as known (they are already leaves, so nothing is placed).

`App` changes: replace `useFocusFallback()`'s `focus` with `placeOrFocus` from `usePaneLayout`; `expectNewSession()` also calls `expectArrival()` and the effect that watches `seen` for the fresh id is removed (arrival handling moved into the hook). The launch `resume` effect calls `placeOrFocus`.

`roster-rows.ts`: add the fourth parameter and `leaf: boolean` to `RosterRow`; `roster.tsx` renders `▪` in place of the leading space when `row.leaf && !row.focused`, and `▸` when focused (unchanged). Row click is Task 8.

- [ ] **Step 4: Run to verify it passes** — `cd /e/Efebia/hiiiid-code && yarn test:tui` and `yarn test:unit`. Expected: PASS. The "hidden session is not re-placed" test depends on Task 7's `Ctrl+W x`; mark it `test.todo` here and enable it in Task 7 if the chord is not wired yet.

- [ ] **Step 5: Gates and commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui
git add -A src/tui src/test
git commit -m "feat: the layout owns the TUI's visible set and places spawned sessions"
```

---

### Task 6: Render panes (`PaneTree`, `Pane`, minimum-size fallback)

**Files:**
- Create: `src/tui/ui/pane-tree.tsx`, `src/tui/ui/pane.tsx`, `src/tui/ui/pane-title.tsx`, `src/tui/ui/divider.tsx`
- Modify: `src/tui/ui/app.tsx` (body), `src/tui/ui/status-line.tsx` (no change expected), `src/tui/ui/roster.tsx` (`+` badge prop)
- Test: extend `src/test/tui/panes.test.tsx`

**Interfaces:**
- Consumes: `layoutRects`, `tooSmall`, `MIN_PANE_W`, `MIN_PANE_H` (`pane-geometry`); `maximizeSizes` (`layout-tree`); `Transcript`, `BottomSlotView`.
- Produces:

```tsx
export function PaneTree(props: {
  area: Rect;                        // cells available to panes (terminal minus roster column, status and notice rows)
  focusedId: SessionId | null;
  liveZone: 'composer' | 'transcript' | null;  // which part of the focused pane takes keys; null when a dialog or the roster has them
  onFocus(id: SessionId): void;
  onHide(id: SessionId): void;
  onOpenPicker?(kind: PickerKind): void;
  onResize(root: LayoutNode): void;             // wired in Task 8
}): JSX.Element;
export const visibleRects: (root: LayoutNode, focusedId: string | null, area: Rect) => ReturnType<typeof layoutRects>;
// Rects of the real tree; if any occupied pane is tooSmall, rects of maximizeSizes(root, focusedId).
```

`app.tsx` computes `area` as `{ x: 0, y: 0, w: width - (showRoster && wide ? ROSTER_W : 0), h: height - 2 }` (`ROSTER_W = 26`, matching `roster.tsx`'s `width={26}`; export it from `roster.tsx`), using `useTerminalDimensions()`. The pane region is a `<box position="relative" flexGrow={1}>` and each `Pane` is `position="absolute"` with `left/top/width/height` from its rect. A pane whose rect is under the minimum after the fallback renders `compact`: one line `glyph title`, no transcript, no composer.

`Pane` renders: `<box border borderStyle="single" borderColor={focused ? theme.colors.primary : theme.colors.border}>` containing `PaneTitle`, `Transcript sessionId focused={focused && liveZone==='transcript'}`, and `<box flexShrink={0}><BottomSlotView sessionId focused={focused && liveZone==='composer'} onOpenPicker/></box>`. Unfocused panes pass `focused={false}`, so a pending approval renders but takes no keys. `PaneTitle` shows the status glyph (reuse `rosterRows`' glyph mapping by exporting `statusGlyph` from `roster-rows.ts`), the title, `host·pid` when foreign, `!` when `bottomSlot` is a permission or question, and a trailing `x`. An empty leaf renders `open a session from the roster`.

- [ ] **Step 1: Write the failing tests** (append to `panes.test.tsx`)

```tsx
test('two panes each render their own transcript', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { name: 'one' }), summary('s2', { name: 'two' })],
    layout: { root: twoUp(), presets: [], focusedSessionId: 's1' },
    snapshots: [
      snapshot('s1', { items: [{ id: 'u1', ts: 1, role: 'user', text: 'alpha message' }] }),
      snapshot('s2', { items: [{ id: 'u2', ts: 1, role: 'user', text: 'beta message' }] }),
    ],
  }));
  await new Promise((r) => setTimeout(r, 20));
  await m.fromHost();
  const f = m.frame();
  expect(f).toContain('alpha message');
  expect(f).toContain('beta message');
});

test('only the focused pane takes composer input', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await m.type('hi');
  await m.press('return');
  const sends = m.posted.filter((p) => p.t === 'send');
  expect(sends.length).toBe(1);
  expect(sends[0]?.t === 'send' && sends[0].id).toBe('s1');
});

test('a pending approval in an unfocused pane is shown but does not answer', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1'), summary('s2', { status: 'awaiting-approval' })],
    layout: { root: twoUp(), presets: [], focusedSessionId: 's1' },
    snapshots: [snapshot('s1'), snapshot('s2', { pending: [{ requestId: 'r1', tool: { kind: 'command', label: 'Bash', command: 'rm x' } }] })],
  }));
  await m.press('y');
  expect(m.posted.filter((p) => p.t === 'permission-decision').length).toBe(0);
  expect(m.frame()).toContain('[y] allow');
});

test('a terminal too narrow for the tree maximizes the focused pane and keeps it usable', async () => {
  m = await mount(<App {...props} />, { width: 70, height: 30 });
  await m.fromHost(hydrateTwo());
  const f = m.frame();
  expect(f.split('\n').every((line) => line.length <= 70)).toBe(true);
  await m.type('hi');
  await m.press('return');
  expect(m.posted.filter((p) => p.t === 'send').length).toBe(1);
});

test('a foreign session in a pane is read-only', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { owner: { host: 'vscode', pid: 42 } }), summary('s2')],
    layout: { root: twoUp(), presets: [], focusedSessionId: 's1' },
    snapshots: [snapshot('s1'), snapshot('s2')],
  }));
  expect(m.frame()).toContain('vscode·42');
  await m.type('hi'); await m.press('return');
  expect(m.posted.filter((p) => p.t === 'send').length).toBe(0);
});
```

Add a mocha test for `visibleRects`'s fallback in `tui-pane-geometry.test.ts`:

```ts
  test('visibleRects falls back to the maximised tree when the real one is too small', () => {
    const root = side(leaf('a'), leaf('b'));
    const real = visibleRects(root, 'a', { x: 0, y: 0, w: 70, h: 30 });
    assert.strictEqual(real.panes.find((p) => p.sessionId === 'a')!.w > real.panes.find((p) => p.sessionId === 'b')!.w, true);
    const roomy = visibleRects(root, 'a', { x: 0, y: 0, w: 101, h: 30 });
    assert.strictEqual(roomy.panes[0].w, 50);
  });
```

Put `visibleRects` in `pane-geometry.ts` (it imports `maximizeSizes` from `./layout-tree`).

- [ ] **Step 2: Run to verify it fails** — `yarn test:tui`, `yarn test:unit`. Expected: FAIL.

- [ ] **Step 3: Implement** the four components and `visibleRects` as specified. `pane-tree.tsx` skeleton:

```tsx
export function PaneTree(p: PaneTreeProps) {
  const { state } = useTuiStore();
  const { panes, dividers } = visibleRects(state.layout.root, p.focusedId, p.area);
  return (
    <box position="relative" flexGrow={1}>
      {panes.map((r) => (
        <box key={r.path.join('.')} position="absolute" left={r.x} top={r.y} width={r.w} height={r.h}>
          {r.sessionId === null
            ? <EmptyLeaf />
            : <Pane sessionId={r.sessionId} compact={r.w < MIN_PANE_W || r.h < MIN_PANE_H}
                focused={r.sessionId === p.focusedId} liveZone={p.liveZone}
                onFocus={p.onFocus} onHide={p.onHide} onOpenPicker={p.onOpenPicker} />}
        </box>
      ))}
      {dividers.map((d) => <Divider key={`${d.path.join('.')}:${d.index}`} rect={d} />)}
    </box>
  );
}
```

`divider.tsx` draws `│` repeated for axis `x` (a column of `│` with `height={rect.h}`), `─` for axis `y`. In `app.tsx`, replace the `body` with `<PaneTree …/>` when any leaf exists or a session is focused; keep `EmptyState` when no leaves and no focus. `keyZone` logic stays (it is derived from the focused pane's `bottomSlot`). When `focusedId` is not among the leaves (a focused session without a pane cannot happen after Task 5, but a stale value must not crash), `PaneTree` still renders and nothing is focused.

- [ ] **Step 4: Run to verify it passes** — `yarn test:tui`, `yarn test:unit`. Look at the rendered frame once by eye (`console.log(m.frame())` in a scratch run, then remove it): borders must not overlap and the divider column must be one cell wide. Registry-style code often forgets `flexDirection="row"`; positions here are absolute so that risk does not apply to panes, but check the title row.

- [ ] **Step 5: Gates and commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui
git add -A src/tui src/client-core src/test
git commit -m "feat: render the TUI's visible sessions as split panes"
```

---

### Task 7: Pane chords wired to layout operations

**Files:**
- Create: `src/tui/ui/use-pane-chords.ts`
- Modify: `src/tui/ui/use-app-keys.ts` (new `onPaneAction` hook point), `src/tui/ui/app.tsx`
- Test: extend `src/test/tui/panes.test.tsx`; enable the todo test from Task 5

**Interfaces:**
- Consumes: `chordStep`, `PaneAction` (`view/pane-keys`); `neighbour`, `visibleRects` (`pane-geometry`); `nudgeFocused`, `evenAll` (`pane-resize`); `usePaneLayout` (`hide`, `armSplit`, `applyRoot`, `placeOrFocus`); `maximizeSizes`.
- Produces: `usePaneChords(opts: { area: Rect; inert: boolean; openNewSessionInSplit(o: 'horizontal'|'vertical'): void; toggleMaximize(): void }): void`, which holds `armedAt` in a ref, subscribes with `useKeyboard`, and on a result with `consumed` calls `key.preventDefault?.()` and `stopPropagation`-equivalent so no other handler (composer, transcript) sees the key.

`App` keeps `const [maximized, setMaximized] = useState(false)`; `PaneTree` gets `root = maximized && focusedId ? maximizeSizes(root, focusedId) : root` for rects only (view-only copy, never posted). Chord semantics:

- `focus`: `neighbour(panes, focusedId, dir)` then `placeOrFocus` (it already has a leaf, so it only focuses); no neighbour is a no-op.
- `split`: `armSplit(orientation)` then open the new-session dialog (`setDialog(true)`); cancelling the dialog calls `armSplit` reset (`armSplit(null)`; widen the API's type to accept `null`).
- `maximize`: toggle `maximized`.
- `even`: `applyRoot(evenAll(root))`.
- `resize`: `applyRoot(nudgeFocused(root, focusedId, dir, 5))`.
- `hide`: `hide(focusedId)`.

The key must not reach the composer: register the chord `useKeyboard` before the others (App-level hook order = subscription order; prompts subscribe after App) and call `key.preventDefault()`; verify in the test that `Ctrl+W` then `h` does not insert `h` into the composer.

- [ ] **Step 1: Write the failing tests**

```tsx
test('Ctrl+W l moves focus to the pane on the right and posts focus-pane', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await m.press('w', { ctrl: true });
  await m.press('l');
  const f = m.posted.filter((p) => p.t === 'focus-pane');
  expect(f[f.length - 1]?.t === 'focus-pane' && f[f.length - 1].sessionId).toBe('s2');
});

test('the chord key never reaches the composer', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await m.press('w', { ctrl: true });
  await m.press('l');
  await m.type('z');
  await m.press('return');
  const send = m.posted.find((p) => p.t === 'send');
  expect(send?.t === 'send' && send.text).toBe('z');
});

test('Ctrl+W x hides the focused pane: one leaf left, set-visible shrinks', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await m.press('w', { ctrl: true });
  await m.press('x');
  const v = lastSetVisible(m.posted);
  expect(v?.t === 'set-visible' && v.sessionIds.join(',')).toBe('s2');
});

test('Ctrl+W | opens the new-session dialog and the created session splits beside the focused pane', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg());
  await m.press('w', { ctrl: true });
  await m.press('|');
  expect(m.frame()).toContain('New session');
  await m.press('return');
  await m.fromHost(
    { t: 'sessions-changed', sessions: [summary('s1'), summary('n1')] },
    { t: 'session-snapshot', session: snapshot('n1') },
  );
  const l = lastSetLayout(m.posted);
  const root = l?.t === 'set-layout' ? l.layout.root : undefined;
  expect(root?.kind === 'split' && root.orientation === 'horizontal' && root.children.length === 2).toBe(true);
});

test('Ctrl+W then Esc cancels, and a plain key afterwards behaves normally', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await m.press('w', { ctrl: true });
  await m.press('escape');
  await new Promise((r) => setTimeout(r, 100));
  await m.type('q');
  await m.press('return');
  const send = m.posted.find((p) => p.t === 'send');
  expect(send?.t === 'send' && send.text).toBe('q');
});

test('Ctrl+W L widens the focused pane by posting one set-layout', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  const before = m.posted.filter((p) => p.t === 'set-layout').length;
  await m.press('w', { ctrl: true });
  await m.press('l', { shift: true });
  const layouts = m.posted.filter((p) => p.t === 'set-layout');
  expect(layouts.length).toBe(before + 1);
  const last = layouts[layouts.length - 1];
  expect(last?.t === 'set-layout' && last.layout.root.kind === 'split' && Math.round(last.layout.root.children[0].size)).toBe(55);
});
```

If `press('|')` does not deliver `sequence: '|'` through `mockInput` (OpenTUI may name it `'|'` or not), the chord test fails with `'New session'` missing; fix by reading the key event's actual `name` in a scratch test and extending `chordAction` to match it. The mocha tests keep `sequence` explicit so they stay valid.

- [ ] **Step 2: Run to verify it fails** — `yarn test:tui`. Expected: FAIL.

- [ ] **Step 3: Implement** `use-pane-chords.ts` and wire it in `App` (before `useAppKeys`). While the chord is armed, show `^W…` in the notice line (`setNotice('^W h j k l focus · | - split · m max · = even · x hide')`, cleared on disarm or after `CHORD_MS`).

- [ ] **Step 4: Run to verify it passes** — `yarn test:tui`, `yarn test:unit`. Expected: PASS, including the Task 5 todo test.

- [ ] **Step 5: Gates and commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui
git add -A src/tui src/test
git commit -m "feat: Ctrl+W pane chords (focus, split, maximize, resize, hide)"
```

---

### Task 8: Mouse

**Files:**
- Modify: `src/tui/ui/pane.tsx`, `src/tui/ui/pane-title.tsx`, `src/tui/ui/divider.tsx`, `src/tui/ui/pane-tree.tsx`, `src/tui/ui/roster.tsx`, `src/tui/ui/transcript/row.tsx` (card header click)
- Test: `src/test/tui/panes-mouse.test.tsx`

**Interfaces:**
- Consumes: `hitDivider`, `dragDivider` (`pane-resize`), `setup.mockMouse` from the test renderer (`click(x, y)`, `drag(x1, y1, x2, y2)`, `scroll(x, y, 'up'|'down')`).
- Produces: behaviour only.

Rules:

- Pane `onMouseDown` focuses the pane (`onFocus(id)`); the title `x` `onMouseDown` calls `onHide(id)` and `stopPropagation()`.
- `Divider` handles `onMouseDown` (start), `onMouseDrag` (compute `pointer = axis === 'x' ? event.x - area.x : event.y - area.y` and set a **local** drag root in `PaneTree` state via `dragDivider(root, rect, pointer)`; the rects render from that copy), and `onMouseUp` / `onMouseDragEnd` (post once through `onResize(dragRoot)` and clear the copy). A drag that ends with no movement posts nothing. If `state.layout.root` changes during a drag (stale path), `dragDivider` returns the root unchanged, so nothing is posted.
- Roster rows: `onMouseDown` on a row calls `onFocusSession(row.id)`.
- Card header: `onMouseDown` on a tool or subagent header toggles it, like `Enter`; reuse the transcript's `open`/`closed` state by lifting the toggle into a `toggleRow(id)` callback passed to `RowView`.
- Wheel: OpenTUI routes `onMouseScroll` to the renderable under the pointer; a scrollbox only scrolls when hovered, so no code is needed. The test below pins it.

- [ ] **Step 1: Write the failing tests**

```tsx
import { afterEach, expect, test } from 'bun:test';
import { App } from '../../tui/ui/app';
import { snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';
// reuse twoUp/hydrateTwo from panes.test.tsx by moving them into ./pane-fixtures.ts and importing from both files

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

test('clicking an unfocused pane focuses it', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await act(async () => { await m!.setup.mockMouse.click(100, 5); });
  await m.fromHost();
  const f = m.posted.filter((p) => p.t === 'focus-pane');
  expect(f[f.length - 1]?.t === 'focus-pane' && f[f.length - 1].sessionId).toBe('s2');
});

test('dragging a divider posts exactly one set-layout with the new sizes', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  const before = m.posted.filter((p) => p.t === 'set-layout').length;
  // roster column is 26 wide on a 140-column terminal; panes span x=26..139, divider near the middle
  await act(async () => { await m!.setup.mockMouse.drag(82, 10, 60, 10); });
  await m.fromHost();
  const layouts = m.posted.filter((p) => p.t === 'set-layout');
  expect(layouts.length).toBe(before + 1);
  const last = layouts[layouts.length - 1];
  expect(last?.t === 'set-layout' && last.layout.root.kind === 'split' && last.layout.root.children[0].size < 50).toBe(true);
});

test('a drag far outside the window clamps to the minimum share', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await act(async () => { await m!.setup.mockMouse.drag(82, 10, 0, 10); });
  await m.fromHost();
  const last = [...m.posted].reverse().find((p) => p.t === 'set-layout');
  expect(last?.t === 'set-layout' && last.layout.root.kind === 'split' && last.layout.root.children[0].size >= 8).toBe(true);
});

test('clicking the title x hides that pane', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  const line = m.frame().split('\n')[0];
  const x = line.lastIndexOf('x');
  await act(async () => { await m!.setup.mockMouse.click(x, 0); });
  await m.fromHost();
  const v = [...m.posted].reverse().find((p) => p.t === 'set-visible');
  expect(v?.t === 'set-visible' && v.sessionIds.length).toBe(1);
});

test('clicking a roster row places or focuses that session', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { name: 'one' }), summary('s2', { name: 'two' })] }));
  const rows = m.frame().split('\n');
  const y = rows.findIndex((l) => l.includes('two'));
  await act(async () => { await m!.setup.mockMouse.click(5, y); });
  await m.fromHost();
  const v = [...m.posted].reverse().find((p) => p.t === 'set-visible');
  expect(v?.t === 'set-visible' && v.sessionIds.includes('s2')).toBe(true);
});
```

Add the `act` import from `react` and the fixtures module. If the title row's `x` column is not at `lastIndexOf('x')` because titles contain `x`, put the title-close glyph as `✕` instead and search for that; use `✕` from the start to avoid the ambiguity.

- [ ] **Step 2: Run to verify it fails** — `yarn test:tui`. Expected: FAIL.

- [ ] **Step 3: Implement** the handlers above. In `PaneTree` hold `const [drag, setDrag] = useState<LayoutNode | null>(null)`; rects use `drag ?? effectiveRoot`.

- [ ] **Step 4: Run to verify it passes** — `yarn test:tui`. Expected: PASS. If a drag posts more than one `set-layout`, `onMouseDragEnd` and `onMouseUp` both fired: post from one of them only.

- [ ] **Step 5: Gates and commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui
git add -A src/tui src/test
git commit -m "feat: mouse support for TUI panes, dividers, roster and cards"
```

---

### Task 9: Fork from the transcript

**Files:**
- Modify: `src/tui/ui/transcript/transcript.tsx`, `src/tui/ui/app.tsx` (arm the arrival), `src/tui/ui/transcript/row.tsx` if the selected row's item id is not already reachable
- Test: `src/test/tui/fork-handoff.test.tsx`

**Interfaces:**
- Consumes: `usePaneLayout().expectArrival`, `armSplit`; `fork-item` action from Task 4.
- Produces: `f` on the selected transcript row posts `{ t: 'fork-session', id: sessionId, itemId: row.id }` and arms the arrival so the fork is placed beside its source and focused. Posting is refused with a notice for a foreign session (`summary.owner` set): `Cannot fork "<title>": owned by <host>`.

The fork placement uses `armSplit('horizontal')` so the fork lands in a new leaf next to the source (not in some distant empty leaf), then `expectArrival()` focuses it.

- [ ] **Step 1: Write the failing tests**

```tsx
test('f on a selected message forks it and the fork lands beside the source, focused', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({
    snapshots: [snapshot('s1', { items: [{ id: 'u1', ts: 1, role: 'user', text: 'first' }, { id: 'a1', ts: 2, role: 'assistant', text: 'second' }] })],
  }));
  await m.press('tab');            // composer -> transcript
  await m.press('k');              // select the last row
  await m.press('f');
  const forks = m.posted.filter((p) => p.t === 'fork-session');
  expect(forks.length).toBe(1);
  expect(forks[0]?.t === 'fork-session' && forks[0].id).toBe('s1');
  await m.fromHost(
    { t: 'sessions-changed', sessions: [summary('s1'), summary('f1')] },
    { t: 'session-snapshot', session: snapshot('f1') },
  );
  const fp = m.posted.filter((p) => p.t === 'focus-pane');
  expect(fp[fp.length - 1]?.t === 'focus-pane' && fp[fp.length - 1].sessionId).toBe('f1');
  const layout = [...m.posted].reverse().find((p) => p.t === 'set-layout');
  expect(layout?.t === 'set-layout' && layout.layout.root.kind).toBe('split');
});

test('forking a foreign session is refused with a notice and posts nothing', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { owner: { host: 'vscode', pid: 7 } })],
    snapshots: [snapshot('s1', { items: [{ id: 'u1', ts: 1, role: 'user', text: 'first' }] })],
  }));
  await m.press('tab');
  await m.press('k');
  await m.press('f');
  expect(m.posted.filter((p) => p.t === 'fork-session').length).toBe(0);
  expect(m.frame()).toContain('owned by vscode');
});

test('f with no selected row does nothing', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg());
  await m.press('tab');
  await m.press('f');
  expect(m.posted.filter((p) => p.t === 'fork-session').length).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails** — `yarn test:tui`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `Transcript`'s key handler:

```ts
else if (action.do === 'fork-item') {
  const row = rows[cursor];
  const s = pane?.summary;
  if (!row || !s) { return; }
  if (s.owner) { setNotice(`Cannot fork "${s.name || s.title}": owned by ${s.owner.host}`); return; }
  onFork(row.id);
}
```

`Transcript` gains an `onFork(itemId)` prop; `Pane` passes a callback that calls `layout.armSplit('horizontal'); layout.expectArrival(); post({ t: 'fork-session', id, itemId })`. `useTuiStore` already provides `setNotice`.

- [ ] **Step 4: Run to verify it passes** — `yarn test:tui`. Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui
git add -A src/tui src/test
git commit -m "feat: fork a session from a transcript message in the TUI"
```

---

### Task 10: Handoff from the new-session dialog

**Files:**
- Modify: `src/tui/ui/new-session-dialog.tsx` (new `handoffFrom?: { id; title }` prop, a toggle row and a seed prompt), `src/tui/ui/app.tsx` (open the dialog with a source; `H` in the roster), `src/tui/ui/roster.tsx` (`roster-handoff` action), `src/tui/ui/status-line.tsx` ("Summarizing")
- Test: extend `src/test/tui/fork-handoff.test.tsx`

**Interfaces:**
- Consumes: `state.handoffPhase[sourceId]` (`'summarizing' | 'done' | undefined`), `roster-handoff` action.
- Produces: `NewSessionDialog` props `{ cwd; initialPrompt?; handoff?: { id: SessionId; title: string }; onClose(); onCreated() }`. With `handoff` set the dialog has a third step `seed` after provider/model: a one-line text entry for the prompt (Enter submits; an empty prompt is allowed, because the router composes the handoff block into the seed and sends it either way). A toggle `h` on the dialog's first step turns the handoff on or off (default **off** from `Ctrl+N`, **on** when opened from `H`). It posts `create-session` with `seed: { text, handoffFrom: handoff.id }` only when the toggle is on and the text or handoff is present.
- `StatusLine`: if `state.handoffPhase[focusedId] === 'summarizing'` replace the line with `Summarizing <title>…`. It is keyed on the **source** session, so show it whenever any session's phase is `'summarizing'`: `Object.entries(state.handoffPhase).find(([, p]) => p === 'summarizing')` and use that session's title.

- [ ] **Step 1: Write the failing tests**

```tsx
test('H on a roster row opens the dialog with a handoff toggle on, and Enter posts a seeded create-session', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { name: 'one' })] }));
  await m.press('tab'); await m.press('tab');            // roster zone
  await m.press('h', { shift: true });
  expect(m.frame()).toContain('Hand off from one');
  await m.press('return');                               // provider
  await m.type('continue the work');
  await m.press('return');                               // submit seed
  const creates = m.posted.filter((p) => p.t === 'create-session');
  expect(creates.length).toBe(1);
  const c = creates[0];
  expect(c?.t === 'create-session' && c.seed?.handoffFrom).toBe('s1');
  expect(c?.t === 'create-session' && c.seed?.text).toBe('continue the work');
});

test('Ctrl+N has the handoff off by default, so no handoffFrom is sent', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg());
  await m.press('n', { ctrl: true });
  await m.press('return');
  const c = m.posted.find((p) => p.t === 'create-session');
  expect(c?.t === 'create-session' && c.seed === undefined).toBe(true);
});

test('Ctrl+N then h turns the handoff on for the focused session', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { name: 'one' })] }));
  await m.press('n', { ctrl: true });
  await m.press('h');
  expect(m.frame()).toContain('Hand off from one');
});

test('the status line says a source is being summarized until the phase is done', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { name: 'one' })] }));
  await m.fromHost({ t: 'handoff-progress', sessionId: 's1', phase: 'summarizing' });
  expect(m.frame()).toContain('Summarizing one');
  await m.fromHost({ t: 'handoff-progress', sessionId: 's1', phase: 'done' });
  expect(m.frame()).not.toContain('Summarizing');
});

test('with no focused session the handoff toggle is unavailable', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [], snapshots: [], layout: { root: { kind: 'leaf', sessionId: null, size: 100 }, presets: [] } }));
  await m.press('n', { ctrl: true });
  await m.press('h');
  expect(m.frame()).not.toContain('Hand off from');
});
```

If `h` conflicts with the dialog's `j/k` navigation keys there is no clash (`h` is unbound in the dialog today); confirm in the dialog's key handler.

- [ ] **Step 2: Run to verify it fails** — `yarn test:tui`. Expected: FAIL.

- [ ] **Step 3: Implement.** Extend `useSyncState` in the dialog with `handoff: boolean` and `seed: string` and `step: 'provider' | 'model' | 'seed'`; the seed step collects printable keys, `backspace`, and `return` to submit; `escape` closes. The final post:

```ts
post({
  t: 'create-session', providerId: provider.id, cwd: props.cwd, model: models[cur.mi]?.id,
  ...(cur.handoff && props.handoff
    ? { seed: { text: cur.seed, handoffFrom: props.handoff.id } }
    : props.initialPrompt ? { seed: { text: props.initialPrompt } } : {}),
});
```

`App` stores `handoffSource: { id; title } | null`; `Ctrl+N` passes the focused session (`focusedId`, with its title from `summary`) with the toggle off, `roster-handoff` passes the row with it on. A handoff creation calls `armSplit('horizontal')` and `expectArrival()` so the new session lands beside its source and takes focus.

- [ ] **Step 4: Run to verify it passes** — `yarn test:tui`. Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui
git add -A src/tui src/test
git commit -m "feat: hand off from a session via the TUI new-session dialog"
```

---

### Task 11: End to end, spawn fix, persistence

**Files:**
- Create: `src/test/tui/e2e-panes.test.tsx`

**Interfaces:**
- Consumes: `mountBooted`, `until`, `makeTmp` (`e2e-harness`), `bootHost`; `Booted.host.manager` (`create`, `setVisible`, `visibleIds`).
- Produces: nothing new.

The spawn tool's exact host action is `manager.create(...)` then `manager.setVisible([...visibleIds(), id])`; the test performs those two calls directly instead of going through the MCP transport (which has its own tests).

- [ ] **Step 1: Write the failing test**

```tsx
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { bootHost } from '../../tui/boot';
import { makeTmp, mountBooted, until } from './e2e-harness';

type Mounted = Awaited<ReturnType<typeof mountBooted>>;
const mounts: Mounted[] = [];
let tmps: string[] = [];
afterEach(async () => {
  for (const m of mounts.splice(0)) { await m.destroy(); }
  for (const t of tmps.splice(0)) { await fs.rm(t, { recursive: true, force: true }); }
});

test('a session spawned the way marcode__spawn_session does gets its own pane', async () => {
  const m = await mountBooted({ prompt: 'first task' });
  mounts.push(m);
  await m.waitFrame((f) => f.includes('first task'));
  const { manager } = m.booted.host;
  const spawned = await manager.create('fake', m.booted.launchCwd, undefined);
  await manager.setVisible([...new Set([...manager.visibleIds(), spawned.state.id])]);
  await until(() => manager.layout().root.kind === 'split');
  expect(JSON.stringify(manager.layout().root)).toContain(spawned.state.id);
});

test('a two-pane layout survives a restart', async () => {
  const tmp = await makeTmp();
  tmps.push(tmp);
  const opts = { home: `${tmp}/home`, cwd: tmp };
  const first = await mountBooted({ ...opts, prompt: 'one' });
  await first.waitFrame((f) => f.includes('one'));
  const { manager } = first.booted.host;
  const second = await manager.create('fake', tmp, undefined);
  await manager.setVisible([...new Set([...manager.visibleIds(), second.state.id])]);
  await until(() => manager.layout().root.kind === 'split');
  await first.destroy();
  const again = await mountBooted(opts);
  mounts.push(again);
  await until(() => again.booted.host.manager.layout().root.kind === 'split');
  expect(again.booted.host.manager.visibleIds().length).toBe(2);
});
```

`mountBooted` must expose `booted` on its return value; if it does not, add `booted` to the returned object in `e2e-harness.tsx` (a one-line change). Delete the unused `bootHost` import if lint flags it.

- [ ] **Step 2: Run to verify it fails** — `cd /e/Efebia/hiiiid-code && bun test src/test/tui/e2e-panes.test.tsx`. Expected: FAIL (before Task 5-6 behaviour is in place this would fail; after, it should pass, so if it already passes the test is not exercising the TUI side: check that a `set-layout` really came from the TUI by asserting `manager.layout().root` contains the id, which only the TUI reconcile writes).

- [ ] **Step 3: Fix whatever the failure shows.** Likely candidates: `booted` not exposed by the harness; `set-visible` posted before the manager has a roster row; `known` not seeded after hydrate.

- [ ] **Step 4: Run to verify it passes** — `yarn test:tui`. Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui
git add -A src/test
git commit -m "test: end to end spawn placement and layout persistence in the TUI"
```

---

### Task 12: Docs, smoke list, roadmap, final gates

**Files:**
- Modify: `docs/tui.md`, `docs/superpowers/roadmap-tui.md`, `docs/superpowers/specs/2026-09-30-marcode-tui-design.md` (one line under "Visible set": superseded by the multi-session spec)

- [ ] **Step 1: Update `docs/tui.md`.** Add to the Keys table: `Ctrl+W` then `h j k l` / arrows (focus the pane in that direction), `|` / `-` (split right / below, opens the new-session dialog), `m` (maximize), `=` (even sizes), `H J K L` (resize 5%), `x` (hide the pane's session); `f` in the transcript (fork the selected message); `Shift+H` in the roster (hand off from a row); `h` in the new-session dialog (toggle handoff from the focused session). Add a "Panes and mouse" section: click a pane, row or card header; drag a divider; the `✕` in a title hides the pane; panes under 40x8 collapse to a peek strip and the focused pane is maximized when the tree does not fit. Change the line "exactly one visible session" wherever it appears. Append to the smoke checklist: drag a divider and see it persist after a restart; wheel over an unfocused pane scrolls only that pane; `Ctrl+W` chords; shrink the terminal through the minimum-size threshold and back; spawn a session from an agent and watch it get a pane without stealing focus; fork at a message; hand off from the roster with `H`.

- [ ] **Step 2: Update the roadmap.** Move C to **Done** with the spec and plan names; list what remains: layout presets UI, drag-to-move panes between slots, grid-shape commands, tabbed panes, fork-to-take-over of a foreign session, the deferred minors from A and B, and phases D to F unchanged. Note anything not verified in a real terminal (mouse drag and wheel reporting, `Ctrl+W` in the terminal multiplexer case where `Ctrl+W` may be intercepted).

- [ ] **Step 3: Run every gate once**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn check-types:tui && yarn test:tui && yarn test:unit && yarn run compile
```

Expected: all pass (re-run `yarn test:unit` once on an `EACCES`/`ENOTEMPTY` flake before investigating).

- [ ] **Step 4: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add docs && git commit -m "docs: TUI panes, mouse, fork and handoff; mark phase C landed"
```

---

## Self-Review

**Spec coverage.** Visible = leaves and the post rules table: Task 5. Spawn placement without focus theft: Task 5 (test 2) and Task 11. Layout reuse and the `reconcilePaneLayout` move: Tasks 1 and 5. Persistence: Task 11 (restart test), relying on the host's existing per-host layout round trip. Minimum size and maximize fallback, `+` badge: Task 6 (the roster `+` badge is the `overflow` prop; add it in Task 6's roster edit: a leaf whose pane rect is under the minimum shows `+`). `PaneTree`, `Pane`, title, empty leaf, focus rules, approvals in unfocused panes: Task 6. Chords: Tasks 4 and 7. Mouse: Task 8. Fork and handoff, foreign refusal: Tasks 9 and 10. Status-line "Summarizing": Task 10. Errors-as-state (stale paths): Tasks 3 and 8. Docs and roadmap: Task 12. Out-of-scope items are not planned.

**Gaps found and fixed inline.** `armSplit(null)` is needed so a cancelled split dialog disarms (noted in Task 7). `visibleRects` lives in `pane-geometry.ts` (Task 6, with its mocha test).

**Type consistency.** `PaneRect`, `DividerRect`, `Rect` defined in Task 2 and used unchanged in 3, 6, 7, 8. `PaneLayoutApi` fields (`placeOrFocus`, `hide`, `armSplit`, `applyRoot`, `expectArrival`) are used by those names in Tasks 6 to 10. `Action` additions (`pane-prefix`, `fork-item`, `roster-handoff`) are defined in Task 4 and consumed in Tasks 7, 9, 10. `rosterRows` gains a fourth parameter in Task 5, and every caller (`roster.tsx`) is updated in the same task.

**Known soft spots to verify at execution time, not placeholders.** (1) The key names OpenTUI gives `|`, `-` and `=` (Task 7 note). (2) Whether `mockMouse.drag` fires `onMouseDragEnd` once (Task 8 note). (3) Absolute positioning inside the pane region needs `position="relative"` on the parent; check the first rendered frame in Task 6.
