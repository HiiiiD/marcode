import assert from 'node:assert/strict';
import { test, suite } from 'mocha';
import {
  validateProviderInstances, resolveEnvMap, computeLoginKind,
  claudeLoginCommand, codexLoginCommand,
} from '../../shared/provider-instances';

suite('shared/provider-instances', () => {
  suite('validateProviderInstances', () => {
    test('accepts a well-formed entry', () => {
      const result = validateProviderInstances(
        [{ id: 'claude-work', kind: 'claude', displayName: 'Claude (work)' }],
        ['claude', 'codex', 'opencode', 'fake'],
      );
      assert.deepStrictEqual(result.valid, [
        { id: 'claude-work', kind: 'claude', displayName: 'Claude (work)' },
      ]);
      assert.deepStrictEqual(result.warnings, []);
    });

    test('passes through binPath and envMap when present', () => {
      const result = validateProviderInstances(
        [{
          id: 'claude-work', kind: 'claude', displayName: 'Claude (work)',
          binPath: '/usr/local/bin/claude',
          envMap: { ANTHROPIC_API_KEY: 'WORK_KEY' },
        }],
        ['claude'],
      );
      assert.deepStrictEqual(result.valid, [{
        id: 'claude-work', kind: 'claude', displayName: 'Claude (work)',
        binPath: '/usr/local/bin/claude', envMap: { ANTHROPIC_API_KEY: 'WORK_KEY' },
      }]);
    });

    test('ignores a non-array value with a warning', () => {
      const result = validateProviderInstances('not-an-array', ['claude']);
      assert.deepStrictEqual(result.valid, []);
      assert.strictEqual(result.warnings.length, 1);
    });

    test('a missing value produces no warning', () => {
      const result = validateProviderInstances(undefined, ['claude']);
      assert.deepStrictEqual(result.valid, []);
      assert.deepStrictEqual(result.warnings, []);
    });

    test('drops an entry with an unknown kind, with a warning', () => {
      const result = validateProviderInstances(
        [{ id: 'x', kind: 'grok', displayName: 'X' }],
        ['claude'],
      );
      assert.deepStrictEqual(result.valid, []);
      assert.strictEqual(result.warnings.length, 1);
    });

    test('drops an entry whose id collides with a base kind id', () => {
      const result = validateProviderInstances(
        [{ id: 'claude', kind: 'claude', displayName: 'Duplicate' }],
        ['claude', 'codex', 'opencode', 'fake'],
      );
      assert.deepStrictEqual(result.valid, []);
      assert.strictEqual(result.warnings.length, 1);
    });

    test('drops the second of two entries sharing an id', () => {
      const result = validateProviderInstances(
        [
          { id: 'dup', kind: 'claude', displayName: 'First' },
          { id: 'dup', kind: 'codex', displayName: 'Second' },
        ],
        ['claude', 'codex'],
      );
      assert.strictEqual(result.valid.length, 1);
      assert.strictEqual(result.valid[0].displayName, 'First');
      assert.strictEqual(result.warnings.length, 1);
    });

    test('drops an entry with no id or no displayName', () => {
      const result = validateProviderInstances(
        [{ kind: 'claude', displayName: 'No id' }, { id: 'no-name', kind: 'claude' }],
        [],
      );
      assert.deepStrictEqual(result.valid, []);
      assert.strictEqual(result.warnings.length, 2);
    });
  });

  suite('resolveEnvMap', () => {
    test('reads each subprocess var from the named OS var', () => {
      const resolved = resolveEnvMap(
        { ANTHROPIC_API_KEY: 'WORK_KEY', ANTHROPIC_BASE_URL: 'WORK_URL' },
        { WORK_KEY: 'sk-123', WORK_URL: 'https://proxy.example' },
      );
      assert.deepStrictEqual(resolved, {
        ANTHROPIC_API_KEY: 'sk-123', ANTHROPIC_BASE_URL: 'https://proxy.example',
      });
    });

    test('omits a subprocess var whose OS var is unset', () => {
      const resolved = resolveEnvMap({ ANTHROPIC_API_KEY: 'MISSING' }, {});
      assert.deepStrictEqual(resolved, {});
    });

    test('an undefined envMap resolves to an empty object', () => {
      assert.deepStrictEqual(resolveEnvMap(undefined, { X: 'y' }), {});
    });
  });

  suite('computeLoginKind', () => {
    test('opencode never offers a login flow', () => {
      assert.strictEqual(computeLoginKind('opencode', {}), 'none');
    });

    test('claude with no key-shaped env is oauth', () => {
      assert.strictEqual(computeLoginKind('claude', {}), 'oauth');
      assert.strictEqual(computeLoginKind('claude', { CLAUDE_CONFIG_DIR: '/tmp/x' }), 'oauth');
    });

    test('claude with an API key or auth token is none', () => {
      assert.strictEqual(computeLoginKind('claude', { ANTHROPIC_API_KEY: 'sk-1' }), 'none');
      assert.strictEqual(computeLoginKind('claude', { ANTHROPIC_AUTH_TOKEN: 'tok' }), 'none');
    });

    test('codex is always oauth, key or no key', () => {
      assert.strictEqual(computeLoginKind('codex', {}), 'oauth');
      assert.strictEqual(computeLoginKind('codex', { OPENAI_API_KEY: 'sk-1' }), 'oauth');
    });
  });

  suite('claudeLoginCommand', () => {
    test('defaults to claude on PATH', () => {
      assert.strictEqual(claudeLoginCommand(undefined), 'claude auth login');
    });
    test('uses a custom binPath', () => {
      assert.strictEqual(claudeLoginCommand('/opt/claude'), '/opt/claude auth login');
    });
  });

  suite('codexLoginCommand', () => {
    test('plain login with no key', () => {
      assert.strictEqual(codexLoginCommand(undefined, {}), 'codex login');
    });
    test('pipes the key through --with-api-key when one is present', () => {
      assert.strictEqual(
        codexLoginCommand(undefined, { OPENAI_API_KEY: 'sk-1' }),
        'printenv OPENAI_API_KEY | codex login --with-api-key',
      );
    });
    test('uses a custom binPath in both forms', () => {
      assert.strictEqual(codexLoginCommand('/opt/codex', {}), '/opt/codex login');
      assert.strictEqual(
        codexLoginCommand('/opt/codex', { OPENAI_API_KEY: 'sk-1' }),
        'printenv OPENAI_API_KEY | /opt/codex login --with-api-key',
      );
    });
  });
});
