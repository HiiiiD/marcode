import * as assert from 'assert';
import { orderWindows } from '../../shared/usage-windows';
import type { UsageWindow } from '../../providers/types';

function w(id: string): UsageWindow {
  return { id, label: id, usedPercent: 0 };
}

suite('orderWindows', () => {
  test('puts known ids in table order regardless of arrival order', () => {
    assert.deepStrictEqual(
      orderWindows([w('seven-day-opus'), w('five-hour'), w('seven-day')]).map((x) => x.id),
      ['five-hour', 'seven-day', 'seven-day-opus'],
    );
  });

  test('keeps an unknown id, last and deterministically', () => {
    assert.deepStrictEqual(
      orderWindows([w('zeta'), w('alpha'), w('five-hour')]).map((x) => x.id),
      ['five-hour', 'alpha', 'zeta'],
    );
  });

  test('does not mutate its input', () => {
    const input = [w('seven-day'), w('five-hour')];
    orderWindows(input);
    assert.deepStrictEqual(input.map((x) => x.id), ['seven-day', 'five-hour']);
  });
});
