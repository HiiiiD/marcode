import * as assert from 'assert';
import { loginProviderFor } from '../../webview/lib/provider-login';

suite('loginProviderFor', () => {
  test('a Claude "not signed in" reason maps to the claude provider', () => {
    assert.strictEqual(
      loginProviderFor('Not signed in to Claude. Run `claude auth login`.'),
      'claude',
    );
  });

  test('a Codex "not signed in" reason maps to the codex provider', () => {
    assert.strictEqual(
      loginProviderFor('Not signed in to Codex. Run `codex login`.'),
      'codex',
    );
  });

  test('an unrelated reason maps to nothing', () => {
    assert.strictEqual(loginProviderFor('Claude Code CLI not found.'), undefined);
  });

  test('undefined input maps to nothing', () => {
    assert.strictEqual(loginProviderFor(undefined), undefined);
  });
});
