import * as assert from 'node:assert';
import { nextCap } from '../../review/use-fleet-diff-requests';
import { FILE_CAP, MAX_FILE_CAP } from '../../shared/file-cap';

suite('nextCap', () => {
  test('doubles from the default when nothing has been raised yet', () => {
    assert.strictEqual(nextCap(undefined), FILE_CAP * 2);
  });

  test('doubles from the current cap', () => {
    assert.strictEqual(nextCap(1000), 2000);
  });

  test('clamps to the ceiling rather than doubling past it', () => {
    assert.strictEqual(nextCap(MAX_FILE_CAP), MAX_FILE_CAP);
    assert.strictEqual(nextCap(1500), MAX_FILE_CAP);
  });
});
