import * as assert from 'assert';
import { summarize } from '../../webview/components/tool-card-format';

suite('tool-card summarize', () => {
  test('returns empty string for null/undefined', () => {
    assert.strictEqual(summarize(null), '');
    assert.strictEqual(summarize(undefined), '');
  });

  test('passes strings through unchanged when short', () => {
    assert.strictEqual(summarize('hello'), 'hello');
  });

  test('truncates JSON longer than the default 44-char budget with an ellipsis', () => {
    const input = { a: 'x'.repeat(100) };
    const result = summarize(input);
    assert.ok(result.endsWith('…'));
    assert.strictEqual(result.length, 44);
  });

  test('summarize fits the sidebar, not a desktop column', () => {
    const long = { path: 'x'.repeat(200) };
    assert.ok(summarize(long).length <= 44, '80 chars was tuned for a width this panel rarely has');
    assert.ok(summarize(long, 80).length <= 80, 'the budget stays overridable');
  });

  test('falls back to a placeholder for a circular object instead of throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.strictEqual(summarize(circular), '<unserializable>');
  });

  test('falls back to a placeholder for a BigInt instead of throwing', () => {
    assert.strictEqual(summarize({ big: BigInt(1) }), '<unserializable>');
  });

  test('falls back to a placeholder for a bare function (JSON.stringify returns undefined)', () => {
    assert.strictEqual(summarize(() => {}), '<unserializable>');
  });
});
