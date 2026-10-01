import * as assert from 'assert';
import { ownerReason } from '../../webview/lib/owner-reason';

suite('ownerReason', () => {
  test('a foreign owner is named with its host and pid', () => {
    assert.strictEqual(ownerReason({ owner: { host: 'vscode', pid: 1234 } }), 'Running in vscode (pid 1234). Read-only here.');
  });
  test('no owner means no reason', () => {
    assert.strictEqual(ownerReason({}), undefined);
  });
});
