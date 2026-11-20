import * as assert from 'assert';
import { providerName } from '../../webview/lib/provider-name';

const state = (catalog: { id: string; displayName: string }[], usage: Record<string, string> = {}) =>
  ({ catalog, usageDisplayNames: usage }) as unknown as Parameters<typeof providerName>[0];

suite('providerName', () => {
  test('the catalog name wins, then the usage report name', () => {
    assert.strictEqual(providerName(state([{ id: 'codex', displayName: 'Codex CLI' }], { codex: 'Codex' }), 'codex'), 'Codex CLI');
    assert.strictEqual(providerName(state([], { codex: 'Codex (plan)' }), 'codex'), 'Codex (plan)');
  });

  test('a built-in backend has one canonical spelling, even for an instance id', () => {
    assert.strictEqual(providerName(state([]), 'opencode'), 'OpenCode');
    assert.strictEqual(providerName(state([]), 'opencode-openai'), 'OpenCode');
    assert.strictEqual(providerName(state([]), 'claude-work'), 'Claude');
  });

  test('an unknown id is capitalised, not shown raw', () => {
    assert.strictEqual(providerName(state([]), 'mystery'), 'Mystery');
  });
});
