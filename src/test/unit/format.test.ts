import * as assert from 'assert';
import { folderName, formatTokens } from '../../webview/format';

suite('folderName', () => {
  test('returns the last segment of a forward-slash path', () => {
    assert.strictEqual(folderName('/repos/hiiiid-code'), 'hiiiid-code');
  });

  test('returns the last segment of a backslash path (Windows)', () => {
    assert.strictEqual(folderName('C:\\Users\\marco\\repos\\hiiiid-code'), 'hiiiid-code');
  });

  test('tolerates a trailing separator', () => {
    assert.strictEqual(folderName('/repos/hiiiid-code/'), 'hiiiid-code');
    assert.strictEqual(folderName('C:\\Users\\marco\\repos\\hiiiid-code\\'), 'hiiiid-code');
  });

  test('a Windows drive root has no last segment below the drive letter, so it renders the drive letter', () => {
    assert.strictEqual(folderName('C:\\'), 'C:');
  });

  test('falls back to the input for an empty string', () => {
    assert.strictEqual(folderName(''), '');
  });

  test('a single segment with no separators is returned as-is', () => {
    assert.strictEqual(folderName('hiiiid-code'), 'hiiiid-code');
  });
});

suite('formatTokens', () => {
  test('renders sub-1000 counts as plain integers', () => {
    assert.strictEqual(formatTokens(0), '0');
    assert.strictEqual(formatTokens(999), '999');
  });

  test('renders thousands with one decimal place and a k suffix', () => {
    assert.strictEqual(formatTokens(1000), '1.0k');
    assert.strictEqual(formatTokens(15400), '15.4k');
  });

  test('rounds to one decimal place for values that are not clean multiples', () => {
    assert.strictEqual(formatTokens(12345), '12.3k');
    assert.strictEqual(formatTokens(12360), '12.4k');
  });
});
