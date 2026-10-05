import * as assert from 'assert';
import { authFailureReason, CLAUDE_SIGN_IN_MESSAGE } from '../../providers/claude/auth-failure';

suite('authFailureReason', () => {
  for (const raw of [
    'Failed to authenticate. API Error: 401',
    'OAuth session expired',
    'Not logged in - Please run /login',
    'Not logged in · Please run /login',
  ]) {
    test(`normalizes "${raw}"`, () => {
      assert.strictEqual(authFailureReason(raw), CLAUDE_SIGN_IN_MESSAGE);
    });
  }

  test('leaves unrelated errors alone', () => {
    assert.strictEqual(authFailureReason('ECONNRESET'), undefined);
    assert.strictEqual(authFailureReason('Invalid API key'), undefined);
  });
});
