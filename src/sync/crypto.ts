import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync,
  randomBytes,
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

export function seal(plain: Buffer, recipientPublicKey: string): string {
  const eph = generateKeyPairSync('x25519');
  const recipient = createPublicKey({ key: Buffer.from(recipientPublicKey, 'base64'), format: 'der', type: 'spki' });
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const ephPub = eph.publicKey.export({ type: 'spki', format: 'der' });
  const { nonce, body } = gcmEncrypt(derive(shared, 'marcode-seal'), plain, ephPub);
  return Buffer.concat([ephPub, nonce, body]).toString('base64');
}

export function unseal(sealed: string, keys: DeviceKeys): Buffer | undefined {
  try {
    const raw = Buffer.from(sealed, 'base64');
    if (raw.length < EPH_PUB + NONCE + TAG) { return undefined; }
    const ephPub = raw.subarray(0, EPH_PUB);
    const publicKey = createPublicKey({ key: ephPub, format: 'der', type: 'spki' });
    const privateKey = createPrivateKey({ key: Buffer.from(keys.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
    const shared = diffieHellman({ privateKey, publicKey });
    return gcmDecrypt(derive(shared, 'marcode-seal'), raw.subarray(EPH_PUB, EPH_PUB + NONCE), raw.subarray(EPH_PUB + NONCE), ephPub);
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
