import * as assert from 'assert';
import { addUsageTotals, sumUsageTotals } from '../../shared/usage-totals';
import type { UsageTotals } from '../../providers/types';

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, ...over,
});

suite('usage-totals', () => {
  test('addUsageTotals adds a delta onto an undefined running total', () => {
    const result = addUsageTotals(undefined, totals({ inputTokens: 10, outputTokens: 5 }));
    assert.deepStrictEqual(result, totals({ inputTokens: 10, outputTokens: 5 }));
  });

  test('addUsageTotals adds a delta onto an existing running total, field by field', () => {
    const running = totals({
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 2,
    });
    const delta = totals({
      inputTokens: 3, outputTokens: 1, cacheReadTokens: 50, cacheCreationTokens: 0,
    });
    assert.deepStrictEqual(
      addUsageTotals(running, delta),
      totals({ inputTokens: 13, outputTokens: 6, cacheReadTokens: 150, cacheCreationTokens: 2 }),
    );
  });

  test('sumUsageTotals sums every field across a list', () => {
    const list = [
      totals({ inputTokens: 10, outputTokens: 5 }),
      totals({ inputTokens: 3, cacheReadTokens: 20 }),
      totals({ cacheCreationTokens: 7 }),
    ];
    assert.deepStrictEqual(
      sumUsageTotals(list),
      totals({ inputTokens: 13, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 7 }),
    );
  });

  test('sumUsageTotals of an empty list is all zeros', () => {
    assert.deepStrictEqual(sumUsageTotals([]), totals());
  });
});
