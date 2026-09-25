import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { formatWhen } from '../../history/format-when';

suite('formatWhen', () => {
  test('renders YYYY-MM-DD HH:mm in local time', () => {
    assert.strictEqual(formatWhen(new Date(2026, 5, 5, 9, 7).getTime()), '2026-06-05 09:07');
  });
});
