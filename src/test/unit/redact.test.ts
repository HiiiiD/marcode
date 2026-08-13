import * as assert from 'assert';
import { redactSecrets } from '../../providers/claude/redact';

suite('redactSecrets', () => {
  test('strips a stderr tail the SDK appended to a thrown error message', () => {
    const message = 'Claude Code process exited with code 1. stderr: '
      + 'curl failed: Authorization: Bearer super-secret-value-not-in-any-known-table';
    assert.strictEqual(
      redactSecrets(message),
      'Claude Code process exited with code 1',
    );
  });

  test('redacts a Bearer/Basic authorization header outside a stderr tail', () => {
    const message = 'request failed: Authorization: Bearer abc123.def456.ghi789';
    assert.strictEqual(redactSecrets(message), 'request failed: [redacted]');
  });

  test('redacts a JWT-shaped token', () => {
    const message = 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM was rejected';
    assert.strictEqual(redactSecrets(message), 'token [redacted] was rejected');
  });

  test('redacts a key=value pair with a secret-shaped key name', () => {
    const message = 'config error: api_key=sk-my-custom-gateway-key-123456 is invalid';
    assert.strictEqual(redactSecrets(message), 'config error: [redacted] is invalid');
  });

  test('redacts credentials embedded in a URL', () => {
    const message = 'failed to fetch https://user:hunter2@example.com/v1/models';
    assert.strictEqual(redactSecrets(message), 'failed to fetch https[redacted]example.com/v1/models');
  });

  test('leaves an ordinary, credential-free message unchanged', () => {
    assert.strictEqual(redactSecrets('spawn claude ENOENT'), 'spawn claude ENOENT');
  });
});
