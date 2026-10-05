# TUI Layout Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a terminal user reshape the split panes from one dialog: pick a built-in or saved preset, dial a rows x columns grid, save the current shape, delete a saved preset.

**Architecture:** Preset data and the apply planning move to `src/client-core/` so the webview menu and the TUI share one list. A pure view model in `src/tui/view/layout-rows.ts` feeds a `LayoutDialog` in the style of `ModeDialog` (one focus ring, `useSyncState` so type-ahead keys each see the previous key's effect). `App` owns `picker === 'layout'`, opened by the `Ctrl+W g` chord or `/layout`, and applies through the existing `layout.applyRoot`.

**Tech Stack:** TypeScript, React 19, OpenTUI (`@opentui/react`), termcn `Dialog`, mocha (pure logic), `bun test` (TUI components).

**Spec:** `docs/superpowers/specs/2026-10-05-tui-layout-dialog-design.md`

## Global Constraints

- No host or protocol change: `set-layout`, `save-preset`, `delete-preset` and `PaneLayout.presets` already exist.
- No `/layout 2x2` argument syntax, no per-shape chords, no preset thumbnails beyond the grid picker's ASCII preview.
- Grid dimensions are bounded 1..6, matching the webview's `MAX_DIM`.
- Nothing under `src/client-core/` imports React, DOM or `vscode`; nothing under `src/tui/` imports `vscode`.
- Filenames are kebab-case.
- The webview preset file is deleted, not re-exported.
- Every other key consumer is inert while a picker is open (the `dialog || deleting || picker` guards); Ctrl+C is swallowed like the other dialogs.
- TUI tests never hand a renderer or renderable to an assertion (`scripts/check-tui-asserts.mjs`); compare strings, booleans, counts.
- Comments only for non-obvious "why". Conventional-commit prefixes. No Claude/Anthropic trailer on commits.
- Run `yarn test:unit`, `yarn test:tui`, `yarn test:dom` (guarded), never the `:raw` variants.

## Review Focus

Inputs the spec implies but its listed tests do not exercise, most likely first:

1. **Type-ahead double Enter** (`pressMany(['return','return'])`) on a non-overflow apply must post `set-layout` once, not twice. Pinned in Task 3.
2. **Stale selection**: a saved preset deleted (here or from another client) while the focus ring sits on or past it must clamp, not crash or act on a missing row. Pinned in Task 3.
3. **Whitespace-only preset name** must be refused with no `save-preset` post, and `s`/`d` typed inside the name prompt must be text, not commands. Pinned in Task 3.
4. **Zero open sessions / bare single-leaf root**: the dialog opens with no focused session (chord and `/layout` both), applying fills nothing and hides nothing. Pinned in Tasks 1 and 4.
5. **Non-grid or oversized current tree**: an asymmetric tree gives no grid dims (steppers start at 1x2), a grid wider than 6 clamps to 6, and `planGrid` called with 0 or 99 clamps rather than building a degenerate tree. Pinned in Tasks 1 and 2.

---

### Task 1: Share presets and apply planning in client-core

**Files:**
- Create: `src/client-core/layout-presets.ts` (moved verbatim from `src/webview/components/layout-presets.ts`)
- Create: `src/client-core/layout-apply.ts`
- Delete: `src/webview/components/layout-presets.ts`
- Modify: `src/webview/components/layout-menu.tsx` (imports, `MAX_DIM`)
- Modify: `src/test/unit/layout-presets.test.ts` (import path)
- Create: `src/test/unit/layout-apply.test.ts`

**Interfaces:**
- Consumes: `fillShapeKeepingOverflow`, `gridLayout`, `LayoutNode` from `src/client-core/layout-tree.ts`.
- Produces (client-core, used by Tasks 2-4):
  - `BUILTIN_PRESETS: LayoutPreset[]`, `shapeMatches(node: LayoutNode, shape: LayoutNode): boolean`
  - `MAX_GRID_DIM = 6`
  - `interface LayoutPlan { root: LayoutNode; hidden: string[] }`
  - `clampDim(n: number): number` (integer in 1..6)
  - `planShape(shape: LayoutNode, openIds: string[]): LayoutPlan`
  - `planGrid(rows: number, cols: number, openIds: string[]): LayoutPlan` (clamps both dims)

  Deviation from the spec text: the spec writes `planShape(root, shape, openIds)`, but `fillShapeKeepingOverflow(shape, ids)` has no use for `root`, so the parameter is dropped.

- [ ] **Step 1: Move the presets file**

```bash
cd /e/Efebia/hiiiid-code
git mv src/webview/components/layout-presets.ts src/client-core/layout-presets.ts
```

In `src/client-core/layout-presets.ts` change the first line's import path from `'../../protocol/messages'` to `'../protocol/messages'`.

- [ ] **Step 2: Point the existing consumers at the new location**

In `src/webview/components/layout-menu.tsx`:

```ts
import { BUILTIN_PRESETS, shapeMatches } from '../../client-core/layout-presets';
```
replacing `from './layout-presets'`.

In `src/test/unit/layout-presets.test.ts`:

```ts
import { BUILTIN_PRESETS, shapeMatches } from '../../client-core/layout-presets';
```

- [ ] **Step 3: Write the failing `layout-apply` tests**

Create `src/test/unit/layout-apply.test.ts`:

```ts
import * as assert from 'assert';
import { BUILTIN_PRESETS } from '../../client-core/layout-presets';
import { clampDim, MAX_GRID_DIM, planGrid, planShape } from '../../client-core/layout-apply';
import { leafSessionIds, slotCount } from '../../client-core/layout-tree';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i + 1}`);
const preset = (id: string) => BUILTIN_PRESETS.find((p) => p.id === id)!.root;

suite('layout-apply clampDim', () => {
  test('keeps 1..6 and clamps outside it', () => {
    assert.strictEqual(MAX_GRID_DIM, 6);
    assert.deepStrictEqual([0, 1, 4, 6, 7, 99, -3].map(clampDim), [1, 1, 4, 6, 6, 6, 1]);
  });
  test('rounds a fractional value and treats NaN as 1', () => {
    assert.strictEqual(clampDim(2.6), 3);
    assert.strictEqual(clampDim(Number.NaN), 1);
  });
});

suite('layout-apply planShape', () => {
  test('fewer sessions than slots: nothing hidden, the rest stay empty', () => {
    const plan = planShape(preset('columns-3'), ids(2));
    assert.deepStrictEqual(plan.hidden, []);
    assert.deepStrictEqual(leafSessionIds(plan.root), ['s1', 's2']);
    assert.strictEqual(slotCount(plan.root), 3);
  });
  test('more sessions than slots: the overflow comes back hidden, in order', () => {
    const plan = planShape(preset('stack-2'), ids(5));
    assert.deepStrictEqual(plan.hidden, ['s3', 's4', 's5']);
    assert.deepStrictEqual(leafSessionIds(plan.root), ['s1', 's2']);
  });
  test('no open sessions: an empty shape, nothing hidden', () => {
    const plan = planShape(preset('grid-2x2'), []);
    assert.deepStrictEqual(plan.hidden, []);
    assert.deepStrictEqual(leafSessionIds(plan.root), []);
  });
});

suite('layout-apply planGrid', () => {
  test('1x1 is a single leaf holding the first session; the rest are hidden', () => {
    const plan = planGrid(1, 1, ids(3));
    assert.strictEqual(plan.root.kind, 'leaf');
    assert.deepStrictEqual(plan.hidden, ['s2', 's3']);
  });
  test('6x6 holds 36 slots and hides nothing for 10 sessions', () => {
    const plan = planGrid(6, 6, ids(10));
    assert.strictEqual(slotCount(plan.root), 36);
    assert.deepStrictEqual(plan.hidden, []);
  });
  test('2x2 with 6 sessions hides the last two', () => {
    assert.deepStrictEqual(planGrid(2, 2, ids(6)).hidden, ['s5', 's6']);
  });
  test('out-of-range dims are clamped, not built', () => {
    assert.strictEqual(slotCount(planGrid(0, 99, ids(1)).root), 6);
    assert.strictEqual(slotCount(planGrid(99, 99, ids(1)).root), 36);
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit`
Expected: FAIL, `Cannot find module '../../client-core/layout-apply'` (the presets test already passes through the moved import).

- [ ] **Step 5: Implement `layout-apply.ts`**

Create `src/client-core/layout-apply.ts`:

```ts
import type { LayoutNode } from '../protocol/messages';
import { fillShapeKeepingOverflow, gridLayout } from './layout-tree';

export const MAX_GRID_DIM = 6;

/** `hidden` is the open session ids no slot can hold; they stay in the roster. */
export interface LayoutPlan { root: LayoutNode; hidden: string[] }

export function clampDim(n: number): number {
  if (Number.isNaN(n)) { return 1; }
  return Math.min(MAX_GRID_DIM, Math.max(1, Math.round(n)));
}

export function planShape(shape: LayoutNode, openIds: string[]): LayoutPlan {
  return fillShapeKeepingOverflow(shape, openIds);
}

export function planGrid(rows: number, cols: number, openIds: string[]): LayoutPlan {
  return gridLayout(clampDim(rows), clampDim(cols), openIds);
}
```

- [ ] **Step 6: Let the webview menu share the bound**

In `src/webview/components/layout-menu.tsx`, delete `const MAX_DIM = 6;`, add `import { MAX_GRID_DIM } from '../../client-core/layout-apply';` and replace both `MAX_DIM` uses with `MAX_GRID_DIM`.

- [ ] **Step 7: Run unit, DOM and type checks**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit && yarn test:dom && yarn check-types`
Expected: all PASS (the DOM layout-menu tests run against the moved presets).

- [ ] **Step 8: Commit**

```bash
git add src/client-core/layout-presets.ts src/client-core/layout-apply.ts src/webview/components/layout-menu.tsx src/test/unit/layout-presets.test.ts src/test/unit/layout-apply.test.ts
git commit -m "refactor: share layout presets and apply planning through client-core"
```

(`git mv` already staged the delete of the webview file; confirm with `git status` that it is part of this commit.)

---

### Task 2: Layout dialog view model

**Files:**
- Create: `src/tui/view/layout-rows.ts`
- Test: `src/test/unit/tui-layout-rows.test.ts`

**Interfaces:**
- Consumes: `BUILTIN_PRESETS`, `shapeMatches` (Task 1); `gridDims`, `LayoutNode` from `client-core/layout-tree`; `clampDim` (Task 1); `LayoutPreset`, `SessionSummary` from `protocol/messages`.
- Produces (used by Task 3):
  - `interface PresetRow { kind: 'builtin' | 'saved'; preset: LayoutPreset; active: boolean }`
  - `presetRows(root: LayoutNode, saved: LayoutPreset[]): PresetRow[]` (built-ins first, then saved)
  - `initialDims(root: LayoutNode): { rows: number; cols: number }` (grid dims clamped to 1..6, else `{ rows: 1, cols: 2 }`)
  - `gridPreview(rows: number, cols: number, filled: number): string[]` (one string per row, `[■]` filled, `[ ]` empty, reading order)
  - `sessionTitles(ids: string[], sessions: SessionSummary[]): string[]` (`name || title || id`)
  - `overflowNotice(titles: string[]): string` (`1 session will be hidden: A` / `N sessions will be hidden: A, B`)

- [ ] **Step 1: Write the failing tests**

Create `src/test/unit/tui-layout-rows.test.ts`:

```ts
import * as assert from 'assert';
import type { LayoutNode, LayoutPreset } from '../../protocol/messages';
import { gridLayout } from '../../client-core/layout-tree';
import { BUILTIN_PRESETS } from '../../client-core/layout-presets';
import { gridPreview, initialDims, overflowNotice, presetRows, sessionTitles } from '../../tui/view/layout-rows';

const leaf = (sessionId: string | null, size = 100): LayoutNode => ({ kind: 'leaf', sessionId, size });
const saved: LayoutPreset = { id: 'p1', name: 'Mine', builtin: false, root: BUILTIN_PRESETS[0].root };

suite('tui layout rows', () => {
  test('presetRows lists built-ins first, then saved, and marks the one matching the root', () => {
    const root = gridLayout(1, 2, ['a', 'b']).root;
    const rows = presetRows(root, [saved]);
    assert.strictEqual(rows.length, BUILTIN_PRESETS.length + 1);
    assert.strictEqual(rows[0].kind, 'builtin');
    assert.strictEqual(rows[rows.length - 1].kind, 'saved');
    assert.deepStrictEqual(rows.filter((r) => r.active).map((r) => r.preset.id), ['columns-2']);
  });

  test('a saved preset is marked active when its shape matches', () => {
    const root = gridLayout(2, 1, ['a', 'b']).root;
    assert.deepStrictEqual(presetRows(root, [saved]).filter((r) => r.active).map((r) => r.preset.id).sort(), ['p1', 'stack-2']);
  });

  test('initialDims reads a grid, clamps a wide one, and falls back for other trees', () => {
    assert.deepStrictEqual(initialDims(gridLayout(3, 2, []).root), { rows: 3, cols: 2 });
    assert.deepStrictEqual(initialDims(leaf('a')), { rows: 1, cols: 1 });
    const wide: LayoutNode = {
      kind: 'split', orientation: 'horizontal', size: 100,
      children: Array.from({ length: 9 }, () => leaf(null, 100 / 9)),
    };
    assert.deepStrictEqual(initialDims(wide), { rows: 1, cols: 6 });
    const asym = BUILTIN_PRESETS.find((p) => p.id === 'asym-1-2')!.root;
    assert.deepStrictEqual(initialDims(asym), { rows: 1, cols: 2 });
  });

  test('gridPreview fills cells in reading order', () => {
    assert.deepStrictEqual(gridPreview(2, 3, 4), ['[■][■][■]', '[■][ ][ ]']);
    assert.deepStrictEqual(gridPreview(1, 1, 0), ['[ ]']);
    assert.deepStrictEqual(gridPreview(1, 2, 9), ['[■][■]']);
  });

  test('sessionTitles prefers name, then title, then the id; unknown ids pass through', () => {
    const sessions = [
      { id: 'a', name: 'Named', title: 'T' },
      { id: 'b', name: '', title: 'Titled' },
    ] as Parameters<typeof sessionTitles>[1];
    assert.deepStrictEqual(sessionTitles(['a', 'b', 'zz'], sessions), ['Named', 'Titled', 'zz']);
  });

  test('overflowNotice is singular for one and lists every title', () => {
    assert.strictEqual(overflowNotice(['A']), '1 session will be hidden: A');
    assert.strictEqual(overflowNotice(['A', 'B']), '2 sessions will be hidden: A, B');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit`
Expected: FAIL, `Cannot find module '../../tui/view/layout-rows'`.

- [ ] **Step 3: Implement**

Create `src/tui/view/layout-rows.ts`:

```ts
import { clampDim } from '../../client-core/layout-apply';
import { BUILTIN_PRESETS, shapeMatches } from '../../client-core/layout-presets';
import { gridDims, type LayoutNode } from '../../client-core/layout-tree';
import type { LayoutPreset, SessionSummary } from '../../protocol/messages';

export interface PresetRow { kind: 'builtin' | 'saved'; preset: LayoutPreset; active: boolean }

export function presetRows(root: LayoutNode, saved: LayoutPreset[]): PresetRow[] {
  const row = (kind: PresetRow['kind']) => (preset: LayoutPreset): PresetRow => (
    { kind, preset, active: shapeMatches(root, preset.root) });
  return [...BUILTIN_PRESETS.map(row('builtin')), ...saved.map(row('saved'))];
}

/** A non-grid tree keeps the webview's default of 1x2 rather than inventing dims for it. */
export function initialDims(root: LayoutNode): { rows: number; cols: number } {
  const dims = gridDims(root);
  return dims ? { rows: clampDim(dims.rows), cols: clampDim(dims.cols) } : { rows: 1, cols: 2 };
}

export function gridPreview(rows: number, cols: number, filled: number): string[] {
  return Array.from({ length: rows }, (_, r) => (
    Array.from({ length: cols }, (_, c) => (r * cols + c < filled ? '[■]' : '[ ]')).join('')));
}

export function sessionTitles(ids: string[], sessions: SessionSummary[]): string[] {
  return ids.map((id) => {
    const s = sessions.find((x) => x.id === id);
    return s?.name || s?.title || id;
  });
}

export function overflowNotice(titles: string[]): string {
  return `${titles.length} session${titles.length === 1 ? '' : 's'} will be hidden: ${titles.join(', ')}`;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit && yarn check-types:tui`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/view/layout-rows.ts src/test/unit/tui-layout-rows.test.ts
git commit -m "feat(tui): view model for the layout dialog"
```

---

### Task 3: The layout dialog component

**Files:**
- Create: `src/tui/ui/layout-dialog.tsx`
- Test: `src/test/tui/layout-dialog.test.tsx`

**Interfaces:**
- Consumes: `planGrid`, `planShape`, `MAX_GRID_DIM`, `LayoutPlan` (Task 1); `presetRows`, `initialDims`, `gridPreview`, `sessionTitles`, `overflowNotice` (Task 2); `leafSessionIds` from `client-core/layout-tree`; `windowAround` from `tui/view/pickers`; `useTuiStore`, `Dialog`, `useSyncState`.
- Produces (used by Task 4): `LayoutDialog({ onApply, onClose }: { onApply(root: LayoutNode): void; onClose(): void })`. It calls `onApply(root)` then `onClose()` on a successful apply; the caller turns `onApply` into the `set-layout` post. It posts `save-preset { name }` and `delete-preset { id }` itself.

Behaviour contract (the tests below pin each line):
- Focus ring order: row 0 Rows, row 1 Columns, then the built-in presets, then the saved presets. Up/Down move; the index is clamped on every read against the current list.
- Left/Right on rows 0/1 step Rows/Columns within 1..6. Enter on rows 0/1 applies the grid; Enter on a preset row applies its shape.
- If `hidden` is non-empty, Enter enters `confirm` mode showing `overflowNotice(...)` and the chosen label; a second Enter applies, Esc returns to the list (the dialog stays open).
- `s` opens the name prompt; Enter saves a trimmed non-empty name (posts `save-preset`, returns to the list); an empty/whitespace name sets an error and posts nothing; Esc cancels the prompt. Inside the prompt every printable key is text.
- `d` on a saved row posts `delete-preset` (no confirmation); on any other row it does nothing.
- Esc in list mode calls `onClose`. Keys with ctrl/meta are ignored in the name prompt.
- After a successful apply, further keys are ignored (`sent` guard), so type-ahead cannot post twice.

- [ ] **Step 1: Write the failing tests**

Create `src/test/tui/layout-dialog.test.tsx`:

```tsx
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { HostToWebview, LayoutNode, LayoutPreset, PaneLayout } from '../../protocol/messages';
import { gridLayout } from '../../client-core/layout-tree';
import { LayoutDialog } from '../../tui/ui/layout-dialog';
import { layoutOf, snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const settleEscape = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); await m!.setup.renderOnce(); };

const sessionsOf = (n: number) => Array.from({ length: n }, (_, i) => `s${i + 1}`);
const hydrateWith = (layout: PaneLayout, count: number): HostToWebview => hydrateMsg({
  sessions: sessionsOf(count).map((id) => summary(id)),
  snapshots: sessionsOf(count).map((id) => snapshot(id)),
  layout,
});
const mine = (id: string, name: string): LayoutPreset => ({
  id, name, builtin: false, root: { kind: 'split', orientation: 'vertical', size: 100, children: [
    { kind: 'leaf', sessionId: null, size: 50 }, { kind: 'leaf', sessionId: null, size: 50 }] },
});

interface Probe { applied: LayoutNode[]; closed: number }
const open = async (msg: HostToWebview): Promise<Probe> => {
  const probe: Probe = { applied: [], closed: 0 };
  m = await mount(<LayoutDialog onApply={(root) => { probe.applied.push(root); }} onClose={() => { probe.closed++; }} />);
  await m.fromHost(msg);
  return probe;
};
const posts = (t: 'save-preset' | 'delete-preset') => (m?.posted ?? []).filter((p) => p.t === t);
const leafCount = (n: LayoutNode): number => (n.kind === 'leaf' ? 1 : n.children.reduce((a, c) => a + leafCount(c), 0));

test('lists the grid steppers, a preview, and the built-in presets with the active one marked', async () => {
  await open(hydrateWith(layoutOf(['s1', 's2'], 'horizontal'), 2));
  const frame = m!.frame();
  expect(frame).toContain('Layout');
  expect(frame).toContain('Rows');
  expect(frame).toContain('Columns');
  expect(frame).toContain('[■][■]');
  expect(frame).toContain('✓ 2 columns');
  expect(frame.includes('✓ 2 rows')).toBe(false);
});

test('the steppers start from the current grid and stop at 1 and 6', async () => {
  await open(hydrateWith({ root: gridLayout(2, 3, sessionsOf(6)).root, presets: [] }, 6));
  expect(m!.frame()).toContain('Rows     ‹ 2 ›');
  expect(m!.frame()).toContain('Columns  ‹ 3 ›');
  await m!.pressMany(['right', 'right', 'right', 'right', 'right']);
  expect(m!.frame()).toContain('Rows     ‹ 6 ›');
  await m!.pressMany(['left', 'left', 'left', 'left', 'left', 'left', 'left']);
  expect(m!.frame()).toContain('Rows     ‹ 1 ›');
});

test('Enter on the Rows row applies the dialled grid and closes', async () => {
  const probe = await open(hydrateWith(layoutOf(['s1', 's2'], 'horizontal'), 2));
  await m!.press('right');
  await m!.press('return');
  expect(probe.applied.length).toBe(1);
  expect(leafCount(probe.applied[0])).toBe(4);
  expect(probe.closed).toBe(1);
});

test('Enter on a built-in preset applies that shape', async () => {
  const probe = await open(hydrateWith(layoutOf(['s1', 's2']), 2));
  await m!.pressMany(['down', 'down', 'return']);
  expect(leafCount(probe.applied[0])).toBe(2);
  expect(probe.applied[0].kind === 'split' && probe.applied[0].orientation).toBe('vertical');
});

test('a non-grid current tree starts the steppers at 1x2', async () => {
  const asym: PaneLayout = { root: { kind: 'split', orientation: 'horizontal', size: 100, children: [
    { kind: 'leaf', sessionId: 's1', size: 50 },
    { kind: 'split', orientation: 'vertical', size: 50, children: [
      { kind: 'leaf', sessionId: 's2', size: 50 }, { kind: 'leaf', sessionId: 's3', size: 50 }] },
  ] }, presets: [] };
  await open(hydrateWith(asym, 3));
  expect(m!.frame()).toContain('Rows     ‹ 1 ›');
  expect(m!.frame()).toContain('Columns  ‹ 2 ›');
  expect(m!.frame()).toContain('✓ 1 large + 2 stacked');
});

test('overflow: Enter asks first, a second Enter applies, and Esc backs out to the list', async () => {
  const probe = await open(hydrateWith(layoutOf(['s1', 's2', 's3']), 3));
  await m!.pressMany(['down', 'down', 'return']);
  expect(probe.applied.length).toBe(0);
  expect(m!.frame()).toContain('1 session will be hidden: Session s3');
  await m!.press('escape');
  await settleEscape();
  expect(probe.closed).toBe(0);
  expect(m!.frame().includes('will be hidden')).toBe(false);
  await m!.pressMany(['return', 'return']);
  expect(probe.applied.length).toBe(1);
  expect(leafCount(probe.applied[0])).toBe(2);
  expect(probe.closed).toBe(1);
});

test('type-ahead double Enter applies once', async () => {
  const probe = await open(hydrateWith(layoutOf(['s1', 's2']), 2));
  await m!.pressMany(['down', 'down', 'down', 'return', 'return']);
  expect(probe.applied.length).toBe(1);
  expect(probe.closed).toBe(1);
});

test('s opens the name prompt; Enter saves the trimmed name and stays open', async () => {
  const probe = await open(hydrateWith(layoutOf(['s1', 's2']), 2));
  await m!.press('s');
  expect(m!.frame()).toContain('Save current layout as');
  await m!.type(' side by side ');
  await m!.press('return');
  const msg = posts('save-preset')[0];
  expect(msg?.t === 'save-preset' && msg.name).toBe('side by side');
  expect(m!.frame().includes('Save current layout as')).toBe(false);
  expect(probe.closed).toBe(0);
});

test('a whitespace-only name posts nothing and shows an error; s and d are plain text in the prompt', async () => {
  await open(hydrateWith(layoutOf(['s1', 's2']), 2));
  await m!.press('s');
  await m!.type('   ');
  await m!.press('return');
  expect(posts('save-preset').length).toBe(0);
  expect(m!.frame()).toContain('Name cannot be empty');
  await m!.type('sd');
  expect(m!.frame()).toContain('Save current layout as: sd');
  expect(posts('delete-preset').length).toBe(0);
});

test('Esc in the name prompt cancels the prompt, not the dialog', async () => {
  const probe = await open(hydrateWith(layoutOf(['s1', 's2']), 2));
  await m!.press('s');
  await m!.press('escape');
  await settleEscape();
  expect(m!.frame().includes('Save current layout as')).toBe(false);
  expect(probe.closed).toBe(0);
});

test('saved presets are listed under their own heading, can be applied, and d deletes one', async () => {
  const probe = await open(hydrateWith({ root: layoutOf(['s1', 's2']).root, presets: [mine('p1', 'Mine')] }, 2));
  expect(m!.frame()).toContain('Saved');
  expect(m!.frame()).toContain('Mine');
  await m!.pressMany(Array.from({ length: 7 }, () => 'down'));
  await m!.press('d');
  const msg = posts('delete-preset')[0];
  expect(msg?.t === 'delete-preset' && msg.id).toBe('p1');
  expect(probe.closed).toBe(0);
});

test('d on a built-in row, the grid rows or Enter-free keys posts nothing', async () => {
  await open(hydrateWith({ root: layoutOf(['s1', 's2']).root, presets: [mine('p1', 'Mine')] }, 2));
  await m!.press('d');
  await m!.pressMany(['down', 'down', 'd']);
  expect(posts('delete-preset').length).toBe(0);
});

test('a preset deleted by another client under the focus ring clamps the selection instead of crashing', async () => {
  const probe = await open(hydrateWith({ root: layoutOf(['s1', 's2']).root, presets: [mine('p1', 'Mine')] }, 2));
  await m!.pressMany(Array.from({ length: 7 }, () => 'down'));
  await m!.fromHost({ t: 'layout-changed', layout: { root: layoutOf(['s1', 's2']).root, presets: [] } });
  await m!.press('return');
  expect(probe.applied.length).toBe(1);
  expect(m!.frame().includes('Mine')).toBe(false);
});

test('opens with no sessions at all and applies an empty shape without hiding anything', async () => {
  const probe = await open(hydrateMsg({ sessions: [], snapshots: [], layout: { root: { kind: 'leaf', sessionId: null, size: 100 }, presets: [] } }));
  expect(m!.frame()).toContain('Layout');
  await m!.pressMany(['down', 'down', 'return']);
  expect(probe.applied.length).toBe(1);
  expect(m!.frame().includes('will be hidden')).toBe(false);
});

test('Esc in the list closes without applying', async () => {
  const probe = await open(hydrateWith(layoutOf(['s1', 's2']), 2));
  await m!.press('escape');
  await settleEscape();
  expect(probe.closed).toBe(1);
  expect(probe.applied.length).toBe(0);
});

test('a long saved list is windowed and the selection stays visible', async () => {
  const many = Array.from({ length: 12 }, (_, i) => mine(`p${i}`, `Saved ${i}`));
  await open(hydrateWith({ root: layoutOf(['s1', 's2']).root, presets: many }, 2));
  await m!.pressMany(Array.from({ length: 2 + 5 + 11 }, () => 'down'));
  expect(m!.frame()).toContain('› ');
  expect(m!.frame()).toContain('Saved 11');
  expect(m!.frame().includes('2 columns')).toBe(false);
});
```

Verify the `layout-changed` message name against `src/protocol/messages.ts` (`grep -n "layout-changed" src/protocol/messages.ts`) and adjust the literal if the field names differ before running.

- [ ] **Step 2: Run to verify they fail**

Run: `cd /e/Efebia/hiiiid-code && yarn test:tui`
Expected: FAIL, `Cannot find module '../../tui/ui/layout-dialog'`.

- [ ] **Step 3: Implement the dialog**

Create `src/tui/ui/layout-dialog.tsx`:

```tsx
import { useKeyboard } from '@opentui/react';
import { useRef } from 'react';
import { MAX_GRID_DIM, planGrid, planShape, type LayoutPlan } from '../../client-core/layout-apply';
import { leafSessionIds, type LayoutNode } from '../../client-core/layout-tree';
import { gridPreview, initialDims, overflowNotice, presetRows, sessionTitles } from '../view/layout-rows';
import { windowAround } from '../view/pickers';
import { useTuiStore } from './store';
import { Dialog } from './termcn/components/ui/dialog';
import { useSyncState } from './use-sync-state';

const LIST_ROWS = 8;
const MAX_NAME = 40;
const FIRST_PRESET = 2;

interface DialogState {
  index: number;
  rows: number;
  cols: number;
  mode: 'list' | 'confirm' | 'name';
  name: string;
  error?: string;
  pending?: { plan: LayoutPlan; label: string };
}

export function LayoutDialog({ onApply, onClose }: { onApply(root: LayoutNode): void; onClose(): void }) {
  const { state, post } = useTuiStore();
  const openIds = leafSessionIds(state.layout.root);
  const presets = presetRows(state.layout.root, state.layout.presets);
  const last = FIRST_PRESET + presets.length - 1;
  const st = useSyncState<DialogState>({ index: 0, ...initialDims(state.layout.root), mode: 'list', name: '' });
  const sent = useRef(false);

  const apply = (root: LayoutNode) => {
    sent.current = true;
    onApply(root);
    onClose();
  };

  useKeyboard((key) => {
    if (sent.current) { return; }
    const cur = st.get();
    const index = Math.min(cur.index, last);

    if (cur.mode === 'name') {
      if (key.name === 'escape') { st.set({ mode: 'list', name: '', error: undefined }); }
      else if (key.name === 'return') {
        const name = cur.name.trim();
        if (name === '') { st.set({ error: 'Name cannot be empty' }); return; }
        post({ t: 'save-preset', name });
        st.set({ mode: 'list', name: '', error: undefined });
      } else if (key.name === 'backspace') { st.set({ name: cur.name.slice(0, -1), error: undefined }); }
      else if (key.sequence && key.sequence.length === 1 && key.sequence >= ' ' && !key.ctrl && !key.meta && cur.name.length < MAX_NAME) {
        st.set({ name: cur.name + key.sequence, error: undefined });
      }
      return;
    }

    if (cur.mode === 'confirm') {
      if (key.name === 'escape') { st.set({ mode: 'list', pending: undefined }); }
      else if (key.name === 'return' && cur.pending) { apply(cur.pending.plan.root); }
      return;
    }

    if (key.name === 'escape') { onClose(); return; }
    if (key.name === 'down') { st.set({ index: Math.min(last, index + 1) }); return; }
    if (key.name === 'up') { st.set({ index: Math.max(0, index - 1) }); return; }
    if (key.name === 's') { st.set({ mode: 'name', name: '', error: undefined }); return; }
    const row = index >= FIRST_PRESET ? presets[index - FIRST_PRESET] : undefined;
    if (key.name === 'd') {
      if (row?.kind === 'saved') { post({ t: 'delete-preset', id: row.preset.id }); }
      return;
    }
    if ((key.name === 'left' || key.name === 'right') && index < FIRST_PRESET) {
      const step = key.name === 'right' ? 1 : -1;
      const field = index === 0 ? 'rows' : 'cols';
      st.set({ [field]: Math.min(MAX_GRID_DIM, Math.max(1, cur[field] + step)) });
      return;
    }
    if (key.name === 'return') {
      if (index >= FIRST_PRESET && !row) { return; }
      const plan = row ? planShape(row.preset.root, openIds) : planGrid(cur.rows, cur.cols, openIds);
      if (plan.hidden.length === 0) { apply(plan.root); return; }
      st.set({ mode: 'confirm', pending: { plan, label: row ? row.preset.name : `${cur.rows}x${cur.cols} grid` } });
    }
  });

  const view = st.view;
  const index = Math.min(view.index, last);
  const { start, end } = windowAround(presets.length, Math.max(0, index - FIRST_PRESET), LIST_ROWS);
  const marker = (i: number) => (i === index ? '›' : ' ');
  return (
    <box flexDirection="column" flexShrink={0}>
      <Dialog isOpen interactive={false} title="Layout">
        <text attributes={index === 0 ? 1 : 0}>{`${marker(0)} Rows     ‹ ${view.rows} ›`}</text>
        <text attributes={index === 1 ? 1 : 0}>{`${marker(1)} Columns  ‹ ${view.cols} ›`}</text>
        {gridPreview(view.rows, view.cols, openIds.length).map((line, i) => <text key={i} fg="gray">{`    ${line}`}</text>)}
        {presets.slice(start, end).map((row, offset) => {
          const i = start + offset;
          const heading = i === start || presets[i - 1].kind !== row.kind;
          return (
            <box key={row.preset.id} flexDirection="column">
              {heading ? <text fg="gray">{row.kind === 'builtin' ? 'Built-in' : 'Saved'}</text> : null}
              <text attributes={index === i + FIRST_PRESET ? 1 : 0}>{`${marker(i + FIRST_PRESET)} ${row.active ? '✓' : ' '} ${row.preset.name}`}</text>
            </box>
          );
        })}
        {view.mode === 'confirm' && view.pending ? (
          <box flexDirection="column">
            <text fg="yellow">{overflowNotice(sessionTitles(view.pending.plan.hidden, state.sessions))}</text>
            <text>{`Apply ${view.pending.label}?`}</text>
          </box>
        ) : null}
        {view.mode === 'name' ? <text>{`Save current layout as: ${view.name}▏`}</text> : null}
        {view.error ? <text fg="red">{view.error}</text> : null}
        <text fg="gray">
          {view.mode === 'name' ? 'Enter save, Esc cancel'
            : view.mode === 'confirm' ? 'Enter apply anyway, Esc back'
              : 'Up/Down move — Left/Right grid — Enter apply — s save — d delete — Esc close'}
        </text>
      </Dialog>
    </box>
  );
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd /e/Efebia/hiiiid-code && yarn test:tui && yarn check-types:tui && yarn lint`
Expected: PASS. If the windowing test's frame assertions fail only because the 30-row test terminal clips rows, raise the mount height rather than weakening the assertion.

- [ ] **Step 5: Commit**

```bash
git add src/tui/ui/layout-dialog.tsx src/test/tui/layout-dialog.test.tsx
git commit -m "feat(tui): layout dialog with grid steppers, presets and overflow confirm"
```

---

### Task 4: Entry points, App wiring and docs

**Files:**
- Modify: `src/tui/view/pickers.ts` (`PickerKind`, `parsePickerCommand`)
- Modify: `src/tui/view/pane-keys.ts` (`PaneAction`, `chordAction`)
- Modify: `src/tui/ui/use-pane-chords.ts` (`onOpenLayout`, `HINT`)
- Modify: `src/tui/ui/app.tsx` (render the dialog, pass `onOpenLayout`)
- Modify: `src/test/unit/tui-pane-keys.test.ts`
- Create: `src/test/tui/layout-entry.test.tsx`
- Modify: `docs/tui.md`, `docs/superpowers/roadmap-tui.md`

**Interfaces:**
- Consumes: `LayoutDialog` (Task 3); `layout.applyRoot` from `usePaneLayout`.
- Produces: `PickerKind` gains `'layout'`; `PaneAction` gains `{ do: 'layout' }`; `PaneChords` gains `onOpenLayout(): void`.

- [ ] **Step 1: Write the failing pane-keys unit test**

Append to the `suite('tui pane chords', ...)` block in `src/test/unit/tui-pane-keys.test.ts`:

```ts
  test('g opens the layout dialog', () => {
    assert.deepStrictEqual(chordStep(100, 200, { name: 'g' }), { armedAt: null, consumed: true, action: { do: 'layout' } });
  });
```

and a picker-command check to the file that covers `parsePickerCommand` (`grep -rn "parsePickerCommand" src/test` to find it; if none, add this to `src/test/unit/tui-pane-keys.test.ts` as a new suite importing `parsePickerCommand` from `'../../tui/view/pickers'`):

```ts
suite('tui picker commands', () => {
  test('/layout is a picker command, with or without surrounding spaces', () => {
    assert.strictEqual(parsePickerCommand('/layout'), 'layout');
    assert.strictEqual(parsePickerCommand('  /layout '), 'layout');
    assert.strictEqual(parsePickerCommand('/layout 2x2'), undefined);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit`
Expected: FAIL (`action` undefined for `g`; `parsePickerCommand('/layout')` undefined).

- [ ] **Step 3: Implement the pure bits**

`src/tui/view/pickers.ts`:

```ts
export type PickerKind = 'model' | 'mode' | 'effort' | 'context' | 'layout';

export function parsePickerCommand(text: string): PickerKind | undefined {
  const match = /^\/(model|mode|effort|context|layout)$/.exec(text.trim());
  return match?.[1] as PickerKind | undefined;
}
```

`src/tui/view/pane-keys.ts`: add `| { do: 'layout' }` to `PaneAction`, and in `chordAction` before the `FOCUS` lookup:

```ts
  if (key.name === 'g') { return { do: 'layout' }; }
```

- [ ] **Step 4: Run to verify the unit tests pass**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit`
Expected: PASS.

- [ ] **Step 5: Write the failing App-level tests**

Create `src/test/tui/layout-entry.test.tsx`:

```tsx
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { App } from '../../tui/ui/app';
import { layoutOf, snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const props = { launchCwd: '/repo', forceNew: false, loginCommands: {}, onQuit: () => {} };
const settleEscape = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); await m!.setup.renderOnce(); };
const three = () => hydrateMsg({
  sessions: ['s1', 's2', 's3'].map((id) => summary(id)),
  snapshots: ['s1', 's2', 's3'].map((id) => snapshot(id)),
  layout: layoutOf(['s1', 's2', 's3']),
});
const setLayouts = () => m!.posted.filter((p) => p.t === 'set-layout');
const leafIds = (root: unknown): string[] => {
  const n = root as { kind: string; sessionId?: string | null; children?: unknown[] };
  return n.kind === 'leaf' ? (n.sessionId ? [n.sessionId] : []) : (n.children ?? []).flatMap(leafIds);
};

test('Ctrl+W g opens the layout dialog', async () => {
  m = await mount(<App {...props} />, { width: 120, height: 40 });
  await m.fromHost(three());
  await m.press('w', { ctrl: true });
  await m.press('g');
  expect(m.frame()).toContain('Built-in');
});

test('/layout typed in the composer opens it and leaves nothing in the draft', async () => {
  m = await mount(<App {...props} />, { width: 120, height: 40 });
  await m.fromHost(three());
  await m.type('/layout');
  await m.press('return');
  expect(m.frame()).toContain('Built-in');
  expect(m.posted.some((p) => p.t === 'send')).toBe(false);
});

test('the chord works with no sessions and no focused pane', async () => {
  m = await mount(<App {...props} />, { width: 120, height: 40 });
  await m.fromHost(hydrateMsg({ sessions: [], snapshots: [], layout: { root: { kind: 'leaf', sessionId: null, size: 100 }, presets: [] } }));
  await m.press('w', { ctrl: true });
  await m.press('g');
  expect(m.frame()).toContain('Built-in');
});

test('applying a built-in posts set-layout with the new shape and closes the dialog', async () => {
  m = await mount(<App {...props} />, { width: 120, height: 40 });
  await m.fromHost(three());
  await m.press('w', { ctrl: true });
  await m.press('g');
  await m.pressMany(['down', 'down', 'down', 'down', 'return']);
  const posted = setLayouts().at(-1);
  expect(posted?.t === 'set-layout' && posted.layout.root.kind === 'split' && posted.layout.root.children.length).toBe(3);
  expect(m.frame().includes('Built-in')).toBe(false);
});

test('overflow hides the extra session from the layout without re-placing it', async () => {
  m = await mount(<App {...props} />, { width: 120, height: 40 });
  await m.fromHost(three());
  await m.press('w', { ctrl: true });
  await m.press('g');
  await m.pressMany(['down', 'down', 'return']);
  expect(m.frame()).toContain('1 session will be hidden');
  await m.press('return');
  const posted = setLayouts().at(-1);
  expect(posted?.t === 'set-layout' && leafIds(posted.layout.root)).toEqual(['s1', 's2']);
  await m.fromHost();
  expect(leafIds((setLayouts().at(-1) as { layout: { root: unknown } }).layout.root)).toEqual(['s1', 's2']);
});

test('while open, other keys are inert: chords, Ctrl+B, Ctrl+N and Ctrl+C do nothing', async () => {
  m = await mount(<App {...props} onQuit={() => { throw new Error('quit'); }} />, { width: 120, height: 40 });
  await m.fromHost(three());
  await m.press('w', { ctrl: true });
  await m.press('g');
  const before = m.posted.length;
  await m.press('w', { ctrl: true });
  await m.press('x');
  await m.press('b', { ctrl: true });
  await m.press('n', { ctrl: true });
  await m.press('c', { ctrl: true });
  await m.press('c', { ctrl: true });
  expect(m.frame()).toContain('Built-in');
  expect(m.frame().includes('Press Ctrl+C again')).toBe(false);
  expect(m.frame().includes('New session')).toBe(false);
  expect(m.posted.length).toBe(before);
});

test('Esc closes the dialog without a layout write', async () => {
  m = await mount(<App {...props} />, { width: 120, height: 40 });
  await m.fromHost(three());
  await m.press('w', { ctrl: true });
  await m.press('g');
  await m.press('escape');
  await settleEscape();
  expect(m.frame().includes('Built-in')).toBe(false);
  expect(setLayouts().length).toBe(0);
});
```

Check `src/test/tui/panes.test.tsx` for how it sends Ctrl+W then a key and mirror any settling it does between the two presses (the chord has a 1.5 s window, so no extra wait is needed, but copy its pattern if it differs). If `set-layout` is posted on mount by reconcile, replace `setLayouts().length` expectations with a count taken before the key presses.

- [ ] **Step 6: Run to verify they fail**

Run: `cd /e/Efebia/hiiiid-code && yarn test:tui`
Expected: FAIL (`Built-in` never appears; `g` consumed with no action).

- [ ] **Step 7: Wire the chord and the App**

`src/tui/ui/use-pane-chords.ts`:

```ts
const HINT = '^W: h j k l focus · | - split · m max · = even · H J K L resize · x hide · g layout';
```

Add `onOpenLayout(): void;` to `PaneChords`. At the top of `run`, before the `if (!focusedId) { return; }` guard:

```ts
    if (action.do === 'layout') { c.onOpenLayout(); return; }
```

`src/tui/ui/app.tsx`: add `import { LayoutDialog } from './layout-dialog';`, pass `onOpenLayout: () => { setPicker('layout'); },` in the `usePaneChords({...})` call, and render beside the other pickers (not gated on `focusedId`):

```tsx
      {picker === 'layout' ? <LayoutDialog onApply={layout.applyRoot} onClose={() => { setPicker(null); }} /> : null}
```

- [ ] **Step 8: Run the whole gate**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit && yarn test:tui && yarn test:dom && yarn check-types && yarn check-types:tui && yarn lint`
Expected: all PASS. If the overflow test shows `s3` re-placed after the apply, that is a real defect in `reconcilePaneLayout` interplay with `usePaneLayout`: stop and report it, do not weaken the test.

- [ ] **Step 9: Update the docs**

`docs/tui.md`:
- Add to the chord table, after the `Ctrl+W, then x` row:
  `| Ctrl+W, then g | anywhere | open the layout dialog: grid rows x columns, built-in and saved presets, save the current shape (\`s\`), delete a saved one (\`d\`). Applying a shape with fewer slots than open sessions asks first; hidden sessions stay in the roster |`
- Change the slash-command row to `` `/model`, `/effort`, `/mode`, `/context`, `/layout` ``.
- Add to the smoke checklist next to the Ctrl+W line:
  `- [ ] Ctrl+W g opens the layout dialog; apply a preset and a 2x3 grid, save the shape, delete it. Inside tmux or screen the chord may be intercepted: \`/layout\` is the fallback.`

`docs/superpowers/roadmap-tui.md`: in the C entry, change the "Left over:" line to drop "layout presets UI" and "grid-shape commands", and add a Done bullet after it:

```
- **C. Layout dialog** (`feat/tui-layout-dialog`): `Ctrl+W g` or `/layout` opens one dialog for grid rows x columns, built-in and saved presets, save-current and delete, with an overflow confirm. Spec `2026-10-05-tui-layout-dialog-design.md`, plan `2026-10-05-tui-layout-dialog.md`. Not verified in a real terminal: the dialog itself, `Ctrl+W g` under a multiplexer.
```

- [ ] **Step 10: Commit**

```bash
git add src/tui src/test docs/tui.md docs/superpowers/roadmap-tui.md
git commit -m "feat(tui): open the layout dialog with Ctrl+W g or /layout"
```

---

## Self-review

- **Spec coverage:** shared presets and `layout-apply` (Task 1); grid, built-in and saved sections, active markers, `d`, `s`, Esc, overflow confirm, steppers bounds (Tasks 2-3); chord, `/layout`, picker contract and inert keys, Ctrl+C swallow (Task 4); docs and roadmap (Task 4); error handling (empty name, stale preset) in Task 3 tests; foreign-owned leaf treated as any leaf (no special code, nothing to test). The DOM layout-menu tests keep running in Task 1 step 7.
- **Deviation to confirm with the user:** `planShape` drops the spec's unused `root` parameter.
- **Type consistency:** `LayoutPlan`, `PresetRow`, `FIRST_PRESET`, `onApply(root)`, `onOpenLayout` and `{ do: 'layout' }` are named identically wherever used.
