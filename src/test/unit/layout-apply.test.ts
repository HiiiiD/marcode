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
