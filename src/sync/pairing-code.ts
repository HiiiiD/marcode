const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LOOKALIKE: Record<string, string> = { O: '0', I: '1', L: '1' };

function toBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) { out += ALPHABET[(value << (5 - bits)) & 31]; }
  return out;
}

function fromBase32(text: string, length: number): Buffer | undefined {
  if (text.length !== Math.ceil((length * 8) / 5)) { return undefined; }
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) { return undefined; }
    value = ((value << 5) | digit) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return out.length === length ? Buffer.from(out) : undefined;
}

/** Crockford base32 behind a prefix, grouped by six for reading aloud or retyping. */
export function encodeCode(prefix: string, bytes: Buffer): string {
  return `${prefix}-${toBase32(bytes).match(/.{1,6}/g)!.join('-')}`;
}

export function decodeCode(prefix: string, code: string, length: number): Buffer | undefined {
  const cleaned = code.toUpperCase().replace(/[\s-]+/g, '');
  if (!cleaned.startsWith(prefix)) { return undefined; }
  const body = cleaned.slice(prefix.length).replace(/[OIL]/g, (c) => LOOKALIKE[c]);
  return fromBase32(body, length);
}

export function encodePairingCode(pairingId: Buffer, secret: Buffer): string {
  return encodeCode('MRC', Buffer.concat([pairingId, secret]));
}

export function decodePairingCode(code: string): { pairingId: Buffer; secret: Buffer } | undefined {
  const bytes = decodeCode('MRC', code, 24);
  return bytes ? { pairingId: bytes.subarray(0, 8), secret: bytes.subarray(8) } : undefined;
}
