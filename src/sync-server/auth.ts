import { createHash, randomBytes } from 'node:crypto';

export function hashSecret(secret: Buffer | string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function bearerOf(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/.exec(header ?? '');
  return match?.[1];
}
