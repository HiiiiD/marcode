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
