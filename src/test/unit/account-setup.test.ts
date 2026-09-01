import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test, suite } from 'mocha';
import {
  CONFIG_COPY_SUBDIRS, CONFIG_DIR_ENV_KEY, ENV_MAP_KEYS, supportsSkillsCopy, defaultConfigDir,
  resolveSourceConfigDir, isDuplicateInstanceId, buildProviderInstanceConfig,
  deriveConfigDirVarName, resolveUniqueConfigDirVarName,
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

  suite('CONFIG_COPY_SUBDIRS', () => {
    test('claude includes commands, codex does not', () => {
      assert.deepStrictEqual(CONFIG_COPY_SUBDIRS.claude, ['skills', 'plugins', 'commands']);
      assert.deepStrictEqual(CONFIG_COPY_SUBDIRS.codex, ['skills', 'plugins']);
    });
  });

  suite('deriveConfigDirVarName', () => {
    test('appends the sanitized, uppercased id to the key', () => {
      assert.strictEqual(
        deriveConfigDirVarName('CLAUDE_CONFIG_DIR', 'claude-personal'),
        'CLAUDE_CONFIG_DIR_CLAUDE_PERSONAL',
      );
    });
    test('replaces non-alphanumeric runs with a single underscore', () => {
      assert.strictEqual(
        deriveConfigDirVarName('CODEX_HOME', 'codex  work!!acct'),
        'CODEX_HOME_CODEX_WORK_ACCT',
      );
    });
    test('trims leading/trailing separators produced by sanitizing', () => {
      assert.strictEqual(
        deriveConfigDirVarName('CLAUDE_CONFIG_DIR', '  -personal-  '),
        'CLAUDE_CONFIG_DIR_PERSONAL',
      );
    });
    test('falls back to a stable suffix when the id sanitizes to nothing', () => {
      assert.strictEqual(deriveConfigDirVarName('CLAUDE_CONFIG_DIR', '---'), 'CLAUDE_CONFIG_DIR_INSTANCE');
    });
  });

  suite('resolveUniqueConfigDirVarName', () => {
    test('returns the derived name when it is not already used', () => {
      const name = resolveUniqueConfigDirVarName('CLAUDE_CONFIG_DIR', 'claude-personal', new Set());
      assert.strictEqual(name, 'CLAUDE_CONFIG_DIR_CLAUDE_PERSONAL');
    });
    test('appends _2 when the derived name is already used', () => {
      const used = new Set(['CLAUDE_CONFIG_DIR_CLAUDE_PERSONAL']);
      const name = resolveUniqueConfigDirVarName('CLAUDE_CONFIG_DIR', 'claude-personal', used);
      assert.strictEqual(name, 'CLAUDE_CONFIG_DIR_CLAUDE_PERSONAL_2');
    });
    test('two ids that sanitize to the same base no longer collide', () => {
      const used = new Set<string>();
      const first = resolveUniqueConfigDirVarName('CLAUDE_CONFIG_DIR', 'claude work', used);
      used.add(first);
      const second = resolveUniqueConfigDirVarName('CLAUDE_CONFIG_DIR', 'Claude-Work', used);
      assert.notStrictEqual(first, second);
    });
    test('keeps incrementing past an already-used suffix', () => {
      const used = new Set(['CLAUDE_CONFIG_DIR_X', 'CLAUDE_CONFIG_DIR_X_2', 'CLAUDE_CONFIG_DIR_X_3']);
      const name = resolveUniqueConfigDirVarName('CLAUDE_CONFIG_DIR', 'x', used);
      assert.strictEqual(name, 'CLAUDE_CONFIG_DIR_X_4');
    });
  });

  suite('buildProviderInstanceConfig', () => {
    test('trims id and displayName', () => {
      const cfg = buildProviderInstanceConfig('claude', '  claude-work  ', '  Work  ', {});
      assert.strictEqual(cfg.id, 'claude-work');
      assert.strictEqual(cfg.displayName, 'Work');
    });
    test('omits envMap entirely when the map is empty', () => {
      const cfg = buildProviderInstanceConfig('codex', 'codex-personal', 'Personal', {});
      assert.strictEqual('envMap' in cfg, false);
    });
    test('includes envMap when non-empty', () => {
      const envMap = { OPENAI_API_KEY: 'MY_KEY' };
      const cfg = buildProviderInstanceConfig('codex', 'codex-personal', 'Personal', envMap);
      assert.deepStrictEqual(cfg.envMap, envMap);
    });
  });
});
