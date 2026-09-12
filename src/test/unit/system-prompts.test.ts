import assert from 'node:assert/strict';
import { test, suite } from 'mocha';
import { validateSystemPrompts } from '../../shared/system-prompts';

const KINDS = {
  claude: 'claude', codex: 'codex', opencode: 'opencode',
  'claude-work': 'claude', 'codex-work': 'codex',
} as const;

suite('shared/system-prompts', () => {
  test('a missing value produces no warning and no prompts', () => {
    const result = validateSystemPrompts(undefined, KINDS);
    assert.deepStrictEqual(result.prompts, {});
    assert.deepStrictEqual(result.warnings, []);
  });

  test('ignores a non-object value with a warning', () => {
    const result = validateSystemPrompts('not-an-object', KINDS);
    assert.deepStrictEqual(result.prompts, {});
    assert.strictEqual(result.warnings.length, 1);
  });

  test('ignores an array value with a warning', () => {
    const result = validateSystemPrompts(['claude'], KINDS);
    assert.deepStrictEqual(result.prompts, {});
    assert.strictEqual(result.warnings.length, 1);
  });

  test('accepts a plain string for a claude id', () => {
    const result = validateSystemPrompts({ claude: 'Be terse.' }, KINDS);
    assert.deepStrictEqual(result.prompts, { claude: 'Be terse.' });
    assert.deepStrictEqual(result.warnings, []);
  });

  test('accepts a plain string for a codex id', () => {
    const result = validateSystemPrompts({ codex: 'Be terse.' }, KINDS);
    assert.deepStrictEqual(result.prompts, { codex: 'Be terse.' });
    assert.deepStrictEqual(result.warnings, []);
  });

  test('accepts the claude_code preset for a claude id, with and without append', () => {
    const result = validateSystemPrompts({
      claude: { preset: 'claude_code' },
      'claude-work': { preset: 'claude_code', append: 'Always run yarn lint first.' },
    }, KINDS);
    assert.deepStrictEqual(result.prompts, {
      claude: { preset: 'claude_code' },
      'claude-work': { preset: 'claude_code', append: 'Always run yarn lint first.' },
    });
    assert.deepStrictEqual(result.warnings, []);
  });

  test('drops the preset object for a codex id, with a warning', () => {
    const result = validateSystemPrompts({ codex: { preset: 'claude_code' } }, KINDS);
    assert.deepStrictEqual(result.prompts, {});
    assert.strictEqual(result.warnings.length, 1);
  });

  test('drops a malformed preset object for a claude id, with a warning', () => {
    const result = validateSystemPrompts({ claude: { preset: 'something-else' } }, KINDS);
    assert.deepStrictEqual(result.prompts, {});
    assert.strictEqual(result.warnings.length, 1);
  });

  test('drops an append that is not a string, with a warning', () => {
    const result = validateSystemPrompts({ claude: { preset: 'claude_code', append: 42 } }, KINDS);
    assert.deepStrictEqual(result.prompts, {});
    assert.strictEqual(result.warnings.length, 1);
  });

  test('drops an empty string, with a warning', () => {
    const result = validateSystemPrompts({ claude: '' }, KINDS);
    assert.deepStrictEqual(result.prompts, {});
    assert.strictEqual(result.warnings.length, 1);
  });

  test('drops an unknown provider id, with a warning', () => {
    const result = validateSystemPrompts({ nope: 'Be terse.' }, KINDS);
    assert.deepStrictEqual(result.prompts, {});
    assert.strictEqual(result.warnings.length, 1);
  });

  test('drops an opencode id, with a warning explaining why', () => {
    const result = validateSystemPrompts({ opencode: 'Be terse.' }, KINDS);
    assert.deepStrictEqual(result.prompts, {});
    assert.strictEqual(result.warnings.length, 1);
    assert.match(result.warnings[0], /OpenCode/);
  });
});
