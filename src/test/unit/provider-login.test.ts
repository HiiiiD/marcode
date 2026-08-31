import * as assert from 'assert';
import { isSignInFailure, shouldOfferLogin } from '../../webview/lib/provider-login';

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

suite('shouldOfferLogin', () => {
  test('loginKind "none" suppresses the button even with sign-in-shaped text', () => {
    assert.strictEqual(
      shouldOfferLogin('Not signed in to Claude. Run `claude auth login`.', 'none'),
      false,
    );
  });

  test('loginKind "oauth" offers the button even with unrelated text', () => {
    assert.strictEqual(shouldOfferLogin('some other failure', 'oauth'), true);
  });

  test('undefined loginKind falls back to the message-text heuristic', () => {
    assert.strictEqual(
      shouldOfferLogin('Not signed in to Codex. Run `codex login`.', undefined),
      true,
    );
    assert.strictEqual(shouldOfferLogin('control request failed', undefined), false);
  });
});
