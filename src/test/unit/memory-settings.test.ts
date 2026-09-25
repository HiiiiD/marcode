import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { validateSummarizer } from '../../shared/memory-settings';

const ids = ['claude', 'codex', 'opencode'];

suite('validateSummarizer', () => {
  test('undefined is off with no warning', () => {
    assert.deepStrictEqual(validateSummarizer(undefined, ids), { setting: { mode: 'off' }, warnings: [] });
  });

  test('llm with provider and model is accepted and effort defaults to low', () => {
    const { setting, warnings } = validateSummarizer(
      { mode: 'llm', provider: 'claude', model: 'claude-haiku-4-5' }, ids,
    );
    assert.deepStrictEqual(setting, { mode: 'llm', provider: 'claude', model: 'claude-haiku-4-5', effort: 'low' });
    assert.deepStrictEqual(warnings, []);
  });

  test('llm without a model warns and falls back to off', () => {
    const { setting, warnings } = validateSummarizer({ mode: 'llm', provider: 'claude' }, ids);
    assert.deepStrictEqual(setting, { mode: 'off' });
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].includes('model'), true);
  });

  test('llm with an unknown provider warns and falls back to off', () => {
    const { setting, warnings } = validateSummarizer({ mode: 'llm', provider: 'nope', model: 'm' }, ids);
    assert.deepStrictEqual(setting, { mode: 'off' });
    assert.strictEqual(warnings[0].includes('"nope"'), true);
  });

  test('an invalid effort warns and uses low', () => {
    const { setting, warnings } = validateSummarizer(
      { mode: 'llm', provider: 'codex', model: 'm', effort: 'turbo' }, ids,
    );
    assert.deepStrictEqual(setting, { mode: 'llm', provider: 'codex', model: 'm', effort: 'low' });
    assert.strictEqual(warnings.length, 1);
  });

  test('a non-object warns and is off', () => {
    const { setting, warnings } = validateSummarizer('llm', ids);
    assert.deepStrictEqual(setting, { mode: 'off' });
    assert.strictEqual(warnings.length, 1);
  });

  test('an unknown mode warns and is off', () => {
    const { setting, warnings } = validateSummarizer({ mode: 'fast' }, ids);
    assert.deepStrictEqual(setting, { mode: 'off' });
    assert.strictEqual(warnings.length, 1);
  });
});
