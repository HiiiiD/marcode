import * as assert from 'assert';
import { redactSecrets } from '../../providers/claude/redact';

suite('redactSecrets', () => {
  test('a realistic auth-failure stderr tail survives readably, not deleted', () => {
    const message = 'Claude Code process exited with code 1. stderr: '
      + 'Error: Not logged in. Your session has expired, please run `claude login`.';
    assert.strictEqual(
      redactSecrets(message),
      'Claude Code process exited with code 1. stderr: '
        + 'Error: Not logged in. Your session has expired, please run `claude login`.',
    );
  });

  test('a secret embedded in a stderr tail is still removed, the rest of the tail survives', () => {
    const message = 'Claude Code process exited with code 1. stderr: '
      + 'curl failed: Authorization: Bearer super-secret-value-not-in-any-known-table';
    assert.strictEqual(
      redactSecrets(message),
      'Claude Code process exited with code 1. stderr: curl failed: Authorization: [redacted]',
    );
  });

  test('a long stderr tail is truncated to a bounded budget rather than kept in full', () => {
    const longTail = 'x'.repeat(500);
    const message = `Claude Code process exited with code 1. stderr: ${longTail}`;
    const result = redactSecrets(message);
    assert.ok(result.startsWith('Claude Code process exited with code 1. stderr: '));
    assert.ok(result.length < message.length);
    assert.ok(result.endsWith('…'));
  });

  test('redacts a Bearer/Basic authorization header outside a stderr tail', () => {
    const message = 'request failed: Authorization: Bearer abc123.def456.ghi789';
    // The literal word "Authorization:" survives — only the Bearer/Basic
    // scheme-and-value pair is secret-shaped and gets redacted. See the
    // "authorization: required" test below for why the bare key name is
    // deliberately not on the secret-key-name list.
    assert.strictEqual(redactSecrets(message), 'request failed: Authorization: [redacted]');
  });

  test('does not redact "authorization: required" — a benign auth-failure message, not a secret', () => {
    assert.strictEqual(
      redactSecrets('request failed: authorization: required'),
      'request failed: authorization: required',
    );
  });

  test('redacts a JWT-shaped token (starts with the "ey" base64url JSON-header prefix)', () => {
    const message = 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM was rejected';
    assert.strictEqual(redactSecrets(message), 'token [redacted] was rejected');
  });

  test('does not redact an ordinary dotted identifier that merely has three long-ish segments', () => {
    const message = 'connecting to some-service.production-east.internal-host failed';
    assert.strictEqual(redactSecrets(message), message);
  });

  test('redacts a key=value pair with a secret-shaped key name', () => {
    const message = 'config error: api_key=sk-my-custom-gateway-key-123456 is invalid';
    assert.strictEqual(redactSecrets(message), 'config error: [redacted] is invalid');
  });

  test('redacts credentials embedded in a URL while keeping the URL legible', () => {
    const message = 'failed to fetch https://user:hunter2@example.com/v1/models';
    assert.strictEqual(
      redactSecrets(message),
      'failed to fetch https://[redacted]@example.com/v1/models',
    );
  });

  test('leaves an ordinary, credential-free message unchanged', () => {
    assert.strictEqual(redactSecrets('spawn claude ENOENT'), 'spawn claude ENOENT');
  });
});
