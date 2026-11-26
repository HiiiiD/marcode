import {
  createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync,
  hkdfSync, randomBytes, timingSafeEqual,
} from 'node:crypto';

export interface DeviceKeys { publicKey: string; privateKey: string }
export interface RecordAad { deviceId: string; recordId: string; epoch: number }

const NONCE = 12;
const TAG = 16;
const EPH_PUB = 44; // X25519 SPKI DER length

function gcmEncrypt(key: Buffer, plain: Buffer, aad?: Buffer): { nonce: Buffer; body: Buffer } {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  if (aad) { cipher.setAAD(aad); }
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { nonce, body: Buffer.concat([ct, cipher.getAuthTag()]) };
}

function gcmDecrypt(key: Buffer, nonce: Buffer, body: Buffer, aad?: Buffer): Buffer | undefined {
  try {
    if (nonce.length !== NONCE || body.length < TAG) { return undefined; }
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    if (aad) { decipher.setAAD(aad); }
    decipher.setAuthTag(body.subarray(body.length - TAG));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG)), decipher.final()]);
  } catch {
    return undefined;
  }
}

function derive(ikm: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32));
}

export function generateDeviceKeys(): DeviceKeys {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

export function generateSyncKey(): string {
  return randomBytes(32).toString('base64');
}

export function isDevicePublicKey(publicKey: string): boolean {
  try {
    return createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType === 'x25519';
  } catch {
    return false;
  }
}

/**
 * `label` (e.g. `epoch:3:device:<id>`) is bound into both the key derivation and the AAD, so the
 * server cannot relabel a blob sealed for one epoch or recipient as another.
 */
export function seal(plain: Buffer, recipientPublicKey: string, label: string): string {
  const eph = generateKeyPairSync('x25519');
  const recipient = createPublicKey({ key: Buffer.from(recipientPublicKey, 'base64'), format: 'der', type: 'spki' });
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const ephPub = eph.publicKey.export({ type: 'spki', format: 'der' });
  const { nonce, body } = gcmEncrypt(derive(shared, `marcode-seal:${label}`), plain, Buffer.concat([ephPub, Buffer.from(label)]));
  return Buffer.concat([ephPub, nonce, body]).toString('base64');
}

export function unseal(sealed: string, keys: DeviceKeys, label: string): Buffer | undefined {
  try {
    const raw = Buffer.from(sealed, 'base64');
    if (raw.length < EPH_PUB + NONCE + TAG) { return undefined; }
    const ephPub = raw.subarray(0, EPH_PUB);
    const publicKey = createPublicKey({ key: ephPub, format: 'der', type: 'spki' });
    const privateKey = createPrivateKey({ key: Buffer.from(keys.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
    const shared = diffieHellman({ privateKey, publicKey });
    return gcmDecrypt(
      derive(shared, `marcode-seal:${label}`), raw.subarray(EPH_PUB, EPH_PUB + NONCE), raw.subarray(EPH_PUB + NONCE),
      Buffer.concat([ephPub, Buffer.from(label)]),
    );
  } catch {
    return undefined;
  }
}

export function wrapWithSecret(plain: Buffer, secret: Buffer): string {
  const { nonce, body } = gcmEncrypt(derive(secret, 'marcode-pair'), plain);
  return Buffer.concat([nonce, body]).toString('base64');
}

export function unwrapWithSecret(wrapped: string, secret: Buffer): Buffer | undefined {
  const raw = Buffer.from(wrapped, 'base64');
  return gcmDecrypt(derive(secret, 'marcode-pair'), raw.subarray(0, NONCE), raw.subarray(NONCE));
}

function aadOf(aad: RecordAad): Buffer {
  return Buffer.from(`${aad.deviceId}:${aad.recordId}:${aad.epoch}`);
}

export function encryptRecord(plain: Buffer, key: string, aad: RecordAad): { nonce: string; ciphertext: string } {
  const { nonce, body } = gcmEncrypt(Buffer.from(key, 'base64'), plain, aadOf(aad));
  return { nonce: nonce.toString('base64'), ciphertext: body.toString('base64') };
}

export function decryptRecord(rec: { nonce: string; ciphertext: string }, key: string, aad: RecordAad): Buffer | undefined {
  return gcmDecrypt(Buffer.from(key, 'base64'), Buffer.from(rec.nonce, 'base64'), Buffer.from(rec.ciphertext, 'base64'), aadOf(aad));
}

function mac(key: string, message: string): Buffer {
  return createHmac('sha256', Buffer.from(key, 'base64')).update(message).digest();
}

function sameMac(expected: Buffer, tag: string): boolean {
  const given = Buffer.from(tag, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Proof, by a key holder, that this device row is one of ours; a row the server invents has none. */
export function admissionTag(key: string, deviceId: string, publicKey: string): string {
  return mac(key, `admit:${deviceId}:${publicKey}`).toString('base64');
}

export function verifyAdmission(key: string, deviceId: string, publicKey: string, tag: string): boolean {
  return sameMac(mac(key, `admit:${deviceId}:${publicKey}`), tag);
}

/** Made with the previous epoch's key, so the server cannot introduce an epoch key of its own. */
export function epochTag(previousKey: string, epoch: number, key: string): string {
  return mac(previousKey, `epoch:${epoch}:${key}`).toString('base64');
}

export function verifyEpoch(previousKey: string, epoch: number, key: string, tag: string): boolean {
  return sameMac(mac(previousKey, `epoch:${epoch}:${key}`), tag);
}
