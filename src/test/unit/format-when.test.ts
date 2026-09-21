import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { formatWhen } from '../../history/format-when';

suite('formatWhen', () => {
  test('renders the year of the timestamp', () => {
    assert.strictEqual(formatWhen(Date.UTC(2026, 5, 15, 12)).includes('2026'), true);
  });
});
