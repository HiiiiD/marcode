import * as assert from 'assert';
import { bestGrid, placeSessionAuto, rearrange, type AutoGridOptions } from '../../client-core/auto-grid';
import { gridDims, gridLayout, leafSessionIds, placeSession, type LayoutNode } from '../../client-core/layout-tree';

const MIN = { width: 320, height: 200 };
const wide: AutoGridOptions = { enabled: true, viewport: { width: 1800, height: 900 }, minPane: MIN };

suite('auto-grid bestGrid', () => {
  test('one session is one pane', () => {
    assert.deepStrictEqual(bestGrid(1, wide.viewport, MIN), { rows: 1, cols: 1 });
  });

  test('four sessions on a wide viewport make a 2x2', () => {
    assert.deepStrictEqual(bestGrid(4, { width: 1600, height: 900 }, MIN), { rows: 2, cols: 2 });
  });

  test('a narrow viewport stacks instead of exceeding the minimum pane width', () => {
    assert.deepStrictEqual(bestGrid(3, { width: 400, height: 900 }, MIN), { rows: 3, cols: 1 });
  });

  test('five sessions prefer 2x3 with one spare cell over taller panes', () => {
    assert.deepStrictEqual(bestGrid(5, wide.viewport, MIN), { rows: 2, cols: 3 });
  });

  test('seven sessions prefer one spare cell (2x4) over two (3x3)', () => {
    assert.deepStrictEqual(bestGrid(7, wide.viewport, MIN), { rows: 2, cols: 4 });
  });

  test('a viewport too small for the minimum pane still yields a grid that fits everyone', () => {
    const { rows, cols } = bestGrid(4, { width: 200, height: 100 }, MIN);
    assert.strictEqual(rows * cols >= 4, true);
  });
});

suite('auto-grid placeSessionAuto', () => {
  const fullGrid = (n: number): LayoutNode => {
    const ids = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));
    return gridLayout(n === 4 ? 2 : 1, n === 4 ? 2 : n, ids).root;
  };
  const custom: LayoutNode = {
    kind: 'split', orientation: 'horizontal', size: 100,
    children: [
      { kind: 'leaf', sessionId: 'a', size: 50 },
      {
        kind: 'split', orientation: 'vertical', size: 50,
        children: [{ kind: 'leaf', sessionId: 'b', size: 50 }, { kind: 'leaf', sessionId: 'c', size: 50 }],
      },
    ],
  };

  test('disabled behaves exactly like placeSession', () => {
    const root = fullGrid(4);
    const out = placeSessionAuto(root, 'e', 'a', 'vertical', { ...wide, enabled: false });
    assert.deepStrictEqual(out, { root: placeSession(root, 'e', 'a', 'vertical'), offerRearrange: false });
  });

  test('an empty slot is filled without regridding', () => {
    const root = gridLayout(2, 2, ['a', 'b', 'c']).root;
    const out = placeSessionAuto(root, 'd', 'a', 'vertical', wide);
    assert.deepStrictEqual(out, { root: placeSession(root, 'd', 'a', 'vertical'), offerRearrange: false });
  });

  test('a full plain grid is rebuilt into the best grid, keeping reading order', () => {
    const out = placeSessionAuto(fullGrid(4), 'e', 'a', 'vertical', wide);
    assert.deepStrictEqual(gridDims(out.root), { rows: 2, cols: 3 });
    assert.deepStrictEqual(leafSessionIds(out.root), ['a', 'b', 'c', 'd', 'e']);
    assert.strictEqual(out.offerRearrange, false);
  });

  test('a full custom layout keeps today\'s placement and offers a rearrange', () => {
    const out = placeSessionAuto(custom, 'd', 'a', 'vertical', wide);
    assert.deepStrictEqual(out.root, placeSession(custom, 'd', 'a', 'vertical'));
    assert.strictEqual(out.offerRearrange, true);
  });

  test('a session that already has a leaf changes nothing', () => {
    const root = fullGrid(4);
    assert.deepStrictEqual(placeSessionAuto(root, 'a', 'a', 'vertical', wide), { root, offerRearrange: false });
  });
});

suite('auto-grid rearrange', () => {
  test('turns a custom layout into the best grid with every session kept in order', () => {
    const custom: LayoutNode = {
      kind: 'split', orientation: 'horizontal', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        {
          kind: 'split', orientation: 'vertical', size: 50,
          children: [{ kind: 'leaf', sessionId: 'b', size: 50 }, { kind: 'leaf', sessionId: 'c', size: 50 }],
        },
      ],
    };
    const out = rearrange(custom, { width: 1600, height: 900 }, MIN);
    assert.deepStrictEqual(leafSessionIds(out), ['a', 'b', 'c']);
    assert.deepStrictEqual(gridDims(out) !== undefined, true);
  });
});
