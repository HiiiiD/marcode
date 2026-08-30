import * as assert from 'assert';
import { isSignInFailure } from '../../webview/lib/provider-login';

suite('isSignInFailure', () => {
  test('a "not signed in" reason is a sign-in failure', () => {
    assert.strictEqual(isSignInFailure('Not signed in to Claude. Run `claude auth login`.'), true);
  });

  test('a differently-worded sign-in reason is still a sign-in failure', () => {
    assert.strictEqual(isSignInFailure('Not signed in to Codex. Run `codex login`.'), true);
  });

  test('an unrelated reason is not a sign-in failure', () => {
    assert.strictEqual(isSignInFailure('Claude Code CLI not found.'), false);
  });

  test('undefined is not a sign-in failure', () => {
    assert.strictEqual(isSignInFailure(undefined), false);
  });
});
