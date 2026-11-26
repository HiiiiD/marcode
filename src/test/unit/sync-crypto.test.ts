import * as assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import { suite, test } from 'mocha';
import {
  admissionTag, decryptRecord, encryptRecord, epochTag, generateDeviceKeys, generateSyncKey, seal, unseal, unwrapWithSecret,
  verifyAdmission, verifyEpoch, wrapWithSecret,
} from '../../sync/crypto';

suite('sync crypto', () => {
  test('seal and unseal round-trip for the recipient only', () => {
    const bob = generateDeviceKeys();
    const eve = generateDeviceKeys();
    const sealed = seal(Buffer.from('epoch key'), bob.publicKey, 'l');
    assert.strictEqual(unseal(sealed, bob, 'l')?.toString(), 'epoch key');
    assert.strictEqual(unseal(sealed, eve, 'l'), undefined);
    assert.strictEqual(unseal('garbage', bob, 'l'), undefined);
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

suite('sync crypto: binding and tags', () => {
  test('a sealed key opens only under the epoch and recipient it was sealed for', () => {
    const bob = generateDeviceKeys();
    const sealed = seal(Buffer.from('k'), bob.publicKey, 'epoch:1:device:bob');
    assert.strictEqual(unseal(sealed, bob, 'epoch:1:device:bob')?.toString(), 'k');
    assert.strictEqual(unseal(sealed, bob, 'epoch:2:device:bob'), undefined);
    assert.strictEqual(unseal(sealed, bob, 'epoch:1:device:eve'), undefined);
  });

  test('admission and epoch tags verify only under the key that made them', () => {
    const key = generateSyncKey();
    const tag = admissionTag(key, 'd1', 'pk');
    assert.strictEqual(verifyAdmission(key, 'd1', 'pk', tag), true);
    assert.strictEqual(verifyAdmission(key, 'd1', 'pk2', tag), false);
    assert.strictEqual(verifyAdmission(generateSyncKey(), 'd1', 'pk', tag), false);
    const next = generateSyncKey();
    const etag = epochTag(key, 2, next);
    assert.strictEqual(verifyEpoch(key, 2, next, etag), true);
    assert.strictEqual(verifyEpoch(key, 3, next, etag), false);
    assert.strictEqual(verifyEpoch(key, 2, generateSyncKey(), etag), false);
    assert.strictEqual(verifyEpoch(key, 2, next, 'not-a-tag'), false);
  });
});
