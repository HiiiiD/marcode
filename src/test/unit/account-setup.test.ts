import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test, suite } from 'mocha';
import {
  CONFIG_DIR_ENV_KEY, ENV_MAP_KEYS, supportsSkillsCopy, defaultConfigDir,
  resolveSourceConfigDir, isDuplicateInstanceId,
} from '../../shared/account-setup';

suite('shared/account-setup', () => {
  suite('supportsSkillsCopy', () => {
    test('true for claude and codex, false for opencode', () => {
      assert.strictEqual(supportsSkillsCopy('claude'), true);
      assert.strictEqual(supportsSkillsCopy('codex'), true);
      assert.strictEqual(supportsSkillsCopy('opencode'), false);
    });
  });

  suite('defaultConfigDir', () => {
    test('claude defaults to <home>/.claude', () => {
      assert.strictEqual(defaultConfigDir('claude', '/home/marco'), path.join('/home/marco', '.claude'));
    });
    test('codex defaults to <home>/.codex', () => {
      assert.strictEqual(defaultConfigDir('codex', '/home/marco'), path.join('/home/marco', '.codex'));
    });
  });

  suite('resolveSourceConfigDir', () => {
    test('uses the main account\'s own env var when set', () => {
      const dir = resolveSourceConfigDir('claude', { CLAUDE_CONFIG_DIR: '/custom/claude' }, '/home/marco');
      assert.strictEqual(dir, '/custom/claude');
    });
    test('falls back to the platform default when unset', () => {
      const dir = resolveSourceConfigDir('codex', {}, '/home/marco');
      assert.strictEqual(dir, path.join('/home/marco', '.codex'));
    });
    test('falls back when the env var is set but empty', () => {
      const dir = resolveSourceConfigDir('claude', { CLAUDE_CONFIG_DIR: '  ' }, '/home/marco');
      assert.strictEqual(dir, path.join('/home/marco', '.claude'));
    });
  });

  suite('isDuplicateInstanceId', () => {
    test('true when id matches a base kind id', () => {
      assert.strictEqual(isDuplicateInstanceId('claude', [], ['claude', 'codex', 'opencode', 'fake']), true);
    });
    test('true when id matches an existing instance id', () => {
      const existing = [{ id: 'claude-work', kind: 'claude' as const, displayName: 'Work' }];
      assert.strictEqual(isDuplicateInstanceId('claude-work', existing, ['claude']), true);
    });
    test('false for a genuinely new id', () => {
      assert.strictEqual(isDuplicateInstanceId('claude-personal', [], ['claude', 'codex', 'opencode', 'fake']), false);
    });
    test('trims whitespace before comparing', () => {
      assert.strictEqual(isDuplicateInstanceId('  claude  ', [], ['claude']), true);
    });
  });

  suite('ENV_MAP_KEYS / CONFIG_DIR_ENV_KEY', () => {
    test('claude envMap keys match package.json\'s schema list', () => {
      assert.deepStrictEqual(
        ENV_MAP_KEYS.claude,
        ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
      );
    });
    test('codex envMap keys match package.json\'s schema list', () => {
      assert.deepStrictEqual(ENV_MAP_KEYS.codex, ['OPENAI_API_KEY', 'CODEX_HOME']);
    });
    test('config-dir env key names', () => {
      assert.deepStrictEqual(CONFIG_DIR_ENV_KEY, { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' });
    });
  });
});
