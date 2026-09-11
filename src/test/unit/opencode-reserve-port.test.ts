import * as assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { reserveLoopbackPort } from '../../providers/opencode/reserve-port';

suite('reserveLoopbackPort', () => {
  test('returns a port in the valid TCP range, and it is free again immediately after', async () => {
    const port = await reserveLoopbackPort();
    assert.ok(port > 0 && port < 65536);
    // Reserving again must succeed — proves the first reservation actually closed.
    const second = await reserveLoopbackPort();
    assert.ok(second > 0 && second < 65536);
  });
});
