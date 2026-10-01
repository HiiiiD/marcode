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
