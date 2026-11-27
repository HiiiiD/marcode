import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { deviceLabel } from '../../client-core/device-label';

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();

suite('deviceLabel', () => {
  test('an online device is just its name and state', () => {
    assert.strictEqual(deviceLabel({ deviceName: 'PC-desk', online: true, lastSeenAt: 0 }), 'PC-desk · online');
  });

  test('an offline device seen today gives the time, otherwise the date too', () => {
    const now = at(2026, 11, 27, 18, 0);
    assert.strictEqual(deviceLabel({ deviceName: 'PC-desk', online: false, lastSeenAt: at(2026, 11, 27, 14, 32) }, now), 'PC-desk · offline, last seen 14:32');
    assert.strictEqual(deviceLabel({ deviceName: 'PC-desk', online: false, lastSeenAt: at(2026, 11, 25, 9, 5) }, now), 'PC-desk · offline, last seen 2026-11-25 09:05');
    assert.strictEqual(deviceLabel({ deviceName: 'PC-desk', online: false, lastSeenAt: 0 }, now), 'PC-desk · offline');
  });
});
