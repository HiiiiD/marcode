import * as assert from 'assert';
import { statusView } from '../../webview/status';

suite('statusView', () => {
  test('awaiting-approval is its own tone, not the error tone', () => {
    assert.notStrictEqual(statusView('awaiting-approval').tone, statusView('error').tone);
  });

  test('only awaiting-approval needs the user', () => {
    assert.strictEqual(statusView('awaiting-approval').needsUser, true);
    for (const s of ['idle', 'running', 'error'] as const) {
      assert.strictEqual(statusView(s).needsUser, false, s);
    }
  });

  test('every status has a human label', () => {
    for (const s of ['idle', 'running', 'awaiting-approval', 'error'] as const) {
      assert.ok(statusView(s).label.length > 0, s);
    }
  });
});
