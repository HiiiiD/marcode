import * as assert from 'node:assert';
import { sendMessageDenial } from '../../providers/claude/send-message-guard';

suite('sendMessageDenial', () => {
  const roster = new Set(['claude-k3j9x0ab', 'my-custom-9z8y7x6w', 'renamed', 's-mtg8t0uv-3']);
  const isSession = (t: string) => roster.has(t.trim().toLowerCase());

  test('denies roster ids and names, custom and renamed included, and points at marcode__send_message', () => {
    for (const to of ['claude-k3j9x0ab', 'my-custom-9z8y7x6w', 'Renamed', 's-mtg8t0uv-3']) {
      const reason = sendMessageDenial({ to, message: 'hi' }, isSession);
      assert.strictEqual(reason?.includes('marcode__send_message'), true, to);
    }
  });

  test('also checks the legacy recipient field', () => {
    assert.strictEqual(sendMessageDenial({ recipient: 'claude-k3j9x0ab' }, isSession) !== undefined, true);
  });

  test('allows subagent ids, other names, broadcast and malformed input', () => {
    for (const to of ['a3d3cf80573ea003d', 'researcher', '*']) {
      assert.strictEqual(sendMessageDenial({ to }, isSession), undefined, to);
    }
    assert.strictEqual(sendMessageDenial(undefined, isSession), undefined);
  });

  test('a subagent-shaped id wins over a session that happens to share it', () => {
    assert.strictEqual(sendMessageDenial({ to: 'a3d3cf80573ea003d' }, () => true), undefined);
  });
});
