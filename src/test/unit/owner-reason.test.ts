import * as assert from 'assert';
import { ownerReason } from '../../webview/lib/owner-reason';

suite('ownerReason', () => {
  test('a foreign owner is named with its host and pid', () => {
    assert.strictEqual(ownerReason({ owner: { host: 'vscode', pid: 1234 } }), 'Running in vscode (pid 1234). Read-only here.');
  });
  test("another device's session names the device", () => {
    const remote = { deviceId: 'd', deviceName: 'PC-desk', online: true, lastSeenAt: 1, relCwd: '.' };
    assert.strictEqual(ownerReason({ remote }), 'On PC-desk. Read-only here.');
    assert.strictEqual(ownerReason({ remote: { ...remote, gap: true } }), 'On PC-desk. Read-only here. Part of this transcript did not arrive.');
    assert.strictEqual(ownerReason({ remote: { ...remote, newerFormat: true } }), "A newer Marcode on PC-desk wrote data this one can't read; update.");
  });
  test('no owner means no reason', () => {
    assert.strictEqual(ownerReason({}), undefined);
  });
});
