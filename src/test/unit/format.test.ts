import * as assert from 'assert';
import { folderName, formatTokens } from '../../webview/format';

suite('folderName', () => {
  test('returns the last segment of a forward-slash path', () => {
    assert.strictEqual(folderName('/repos/mar-code'), 'mar-code');
  });

  test('returns the last segment of a backslash path (Windows)', () => {
    assert.strictEqual(folderName('C:\\Users\\marco\\repos\\mar-code'), 'mar-code');
  });

  test('tolerates a trailing separator', () => {
    assert.strictEqual(folderName('/repos/mar-code/'), 'mar-code');
    assert.strictEqual(folderName('C:\\Users\\marco\\repos\\mar-code\\'), 'mar-code');
  });

  test('a Windows drive root has no last segment below the drive letter, so it renders the drive letter', () => {
    assert.strictEqual(folderName('C:\\'), 'C:');
  });

  test('falls back to the input for an empty string', () => {
    assert.strictEqual(folderName(''), '');
  });

  test('a single segment with no separators is returned as-is', () => {
    assert.strictEqual(folderName('mar-code'), 'mar-code');
  });
});

suite('formatTokens', () => {
  test('renders sub-1000 counts as plain integers', () => {
    assert.strictEqual(formatTokens(0), '0');
    assert.strictEqual(formatTokens(999), '999');
  });

  test('renders thousands with a K suffix, dropping the decimal for clean multiples', () => {
    assert.strictEqual(formatTokens(1000), '1K');
    assert.strictEqual(formatTokens(15400), '15.4K');
  });

  test('rounds to one decimal place for values that are not clean multiples', () => {
    assert.strictEqual(formatTokens(12345), '12.3K');
    assert.strictEqual(formatTokens(12360), '12.4K');
  });

  test('renders millions with an M suffix, dropping the decimal for clean multiples', () => {
    assert.strictEqual(formatTokens(1_000_000), '1M');
    assert.strictEqual(formatTokens(2_000_000), '2M');
    assert.strictEqual(formatTokens(2_540_000), '2.5M');
  });
});
