import * as assert from 'assert';
import { childrenRows } from '../../client-core/children-rows';
import type { ChildRef } from '../../protocol/messages';

const child = (id: string, over: Partial<ChildRef> = {}): ChildRef =>
  ({ id, title: `T ${id}`, origin: 'fork', hidden: false, status: 'idle', ...over });

suite('childrenRows', () => {
  test('a fork, a hidden side chat and a promoted side chat get their own badges', () => {
    const rows = childrenRows([
      child('f'), child('s', { origin: 'side', hidden: true }), child('p', { origin: 'side', hidden: false }),
    ]);

    assert.deepStrictEqual(rows.map((r) => [r.id, r.badge]), [['f', 'Fork'], ['s', 'Side chat'], ['p', 'Promoted']]);
  });

  test('keeps the host order and each row title and status', () => {
    const rows = childrenRows([child('b', { status: 'running' }), child('a')]);

    assert.deepStrictEqual(rows.map((r) => [r.id, r.title, r.status]), [['b', 'T b', 'running'], ['a', 'T a', 'idle']]);
  });

  test('no list is no rows', () => {
    assert.deepStrictEqual(childrenRows(undefined), []);
    assert.deepStrictEqual(childrenRows([]), []);
  });
});
