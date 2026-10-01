import * as assert from 'node:assert';
import type { LayoutNode } from '../../client-core/layout-tree';
import { hitDivider, hitPane, layoutRects, neighbour, tooSmall, visibleRects } from '../../client-core/pane-geometry';

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
  test('neighbour picks the pane across the shared edge, topmost or leftmost when several share the edge', () => {
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
    assert.strictEqual(tooSmall(layoutRects(side(leaf('a', 80), leaf(null, 20)), { x: 0, y: 0, w: 101, h: 30 }).panes), false);
  });
  test('visibleRects falls back to the maximised tree when the real one is too small', () => {
    const root = side(leaf('a'), leaf('b'));
    const squeezed = visibleRects(root, 'a', { x: 0, y: 0, w: 70, h: 30 });
    const w = (id: string) => squeezed.panes.find((p) => p.sessionId === id)!.w;
    assert.strictEqual(w('a') > w('b'), true);
    assert.strictEqual(visibleRects(root, 'a', area).panes[0].w, 50);
  });
});
