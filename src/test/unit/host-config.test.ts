import * as assert from 'assert';
import { defaultHostConfig, parseHostConfig, reloadSignature } from '../../host/host-config';

suite('host-config', () => {
  test('an absent file is the defaults with no warnings', () => {
    const { config, warnings } = parseHostConfig(undefined);
    assert.deepStrictEqual(config, defaultHostConfig());
    assert.deepStrictEqual(warnings, []);
  });

  test('the default provider list matches the extension default', () => {
    assert.deepStrictEqual(defaultHostConfig().enabledProviders, ['claude', 'codex', 'opencode']);
  });

  test('a non-object file is the defaults plus one warning', () => {
    const { config, warnings } = parseHostConfig([1, 2]);
    assert.deepStrictEqual(config, defaultHostConfig());
    assert.strictEqual(warnings.length, 1);
  });

  test('a wrong-typed key falls back to its default and names the key', () => {
    const { config, warnings } = parseHostConfig({ enabledProviders: 'claude', memory: { enabled: 'yes' } });
    assert.deepStrictEqual(config.enabledProviders, defaultHostConfig().enabledProviders);
    assert.strictEqual(config.memory.enabled, true);
    assert.strictEqual(warnings.some((w) => w.includes('enabledProviders')), true);
    assert.strictEqual(warnings.some((w) => w.includes('memory.enabled')), true);
  });

  test('an empty provider list is honoured, not replaced by the default', () => {
    assert.deepStrictEqual(parseHostConfig({ enabledProviders: [] }).config.enabledProviders, []);
  });

  test('unknown provider ids are kept out and named', () => {
    const { config, warnings } = parseHostConfig({ enabledProviders: ['claude', 'cluade'] });
    assert.deepStrictEqual(config.enabledProviders, ['claude']);
    assert.strictEqual(warnings.some((w) => w.includes('cluade')), true);
  });

  test('empty binary paths mean "from PATH"', () => {
    const { config } = parseHostConfig({ codexPath: '', opencodePath: '/x/opencode' });
    assert.strictEqual(config.codexPath, undefined);
    assert.strictEqual(config.opencodePath, '/x/opencode');
  });

  test('review settings are clamped through the existing rules', () => {
    const { config } = parseHostConfig({ review: { fileCap: 9_999_999, pollIntervalMs: 1, baseRefs: ['develop', 3, ' '] } });
    assert.strictEqual(config.review.fileCap, 2000);
    assert.strictEqual(config.review.pollIntervalMs, 100);
    assert.deepStrictEqual(config.review.baseRefs, ['develop']);
  });

  test('usage mirrors with a missing field or a broken pattern are dropped', () => {
    const ok = { sourceProviderId: 'a', modelPattern: '^x', targetProviderId: 'b', usageProviderId: 'c', displayName: 'D' };
    const { config } = parseHostConfig({ usageMirrors: [ok, { ...ok, modelPattern: '(' }, { ...ok, displayName: '' }, 5] });
    assert.strictEqual(config.usageMirrors.length, 1);
  });

  test('reloadSignature ignores favoriteModels and nothing else', () => {
    const a = defaultHostConfig();
    const b = { ...a, favoriteModels: ['fake x'] };
    const c = { ...a, enabledProviders: ['claude'] };
    assert.strictEqual(reloadSignature(a), reloadSignature(b));
    assert.notStrictEqual(reloadSignature(a), reloadSignature(c));
  });
});
