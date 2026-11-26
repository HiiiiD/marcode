import * as assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import { suite, test } from 'mocha';
import {
  decryptRecord, encryptRecord, generateDeviceKeys, generateSyncKey, seal, unseal, unwrapWithSecret, wrapWithSecret,
} from '../../sync/crypto';

suite('sync crypto', () => {
  test('seal and unseal round-trip for the recipient only', () => {
    const bob = generateDeviceKeys();
    const eve = generateDeviceKeys();
    const sealed = seal(Buffer.from('epoch key'), bob.publicKey);
    assert.strictEqual(unseal(sealed, bob)?.toString(), 'epoch key');
    assert.strictEqual(unseal(sealed, eve), undefined);
    assert.strictEqual(unseal('garbage', bob), undefined);
  });

  test('wrap and unwrap need the same secret', () => {
    const secret = randomBytes(16);
    const wrapped = wrapWithSecret(Buffer.from('keys'), secret);
    assert.strictEqual(unwrapWithSecret(wrapped, secret)?.toString(), 'keys');
    assert.strictEqual(unwrapWithSecret(wrapped, randomBytes(16)), undefined);
  });

  test('a record decrypts only under its own key and labels', () => {
    const key = generateSyncKey();
    const aad = { deviceId: 'd1', recordId: 'r1', epoch: 1 };
    const rec = encryptRecord(Buffer.from('{"v":1}'), key, aad);
    assert.strictEqual(decryptRecord(rec, key, aad)?.toString(), '{"v":1}');
    const flipped = Buffer.from(rec.ciphertext, 'base64');
    flipped[0] ^= 1;
    assert.strictEqual(decryptRecord({ ...rec, ciphertext: flipped.toString('base64') }, key, aad), undefined);
    assert.strictEqual(decryptRecord(rec, key, { ...aad, recordId: 'r2' }), undefined);
    assert.strictEqual(decryptRecord(rec, key, { ...aad, deviceId: 'd2' }), undefined);
    assert.strictEqual(decryptRecord(rec, key, { ...aad, epoch: 2 }), undefined);
    assert.strictEqual(decryptRecord(rec, generateSyncKey(), aad), undefined);
  });

  test('encrypting twice uses fresh nonces', () => {
    const key = generateSyncKey();
    const aad = { deviceId: 'd1', recordId: 'r1', epoch: 1 };
    assert.notStrictEqual(encryptRecord(Buffer.from('x'), key, aad).nonce, encryptRecord(Buffer.from('x'), key, aad).nonce);
  });
});
