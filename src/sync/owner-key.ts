import { createHmac } from 'node:crypto';
import type { SyncCredentials } from './credentials';

/** The session's name on the server: every key holder derives the same one, and the server cannot reverse it. */
export function ownerKey(creds: SyncCredentials, sessionId: string): string {
  const oldest = [...creds.syncKeys].sort((a, b) => a.epoch - b.epoch)[0];
  if (!oldest) { throw new Error('no sync key'); }
  return createHmac('sha256', Buffer.from(oldest.key, 'base64')).update(`owner:${sessionId}`).digest('hex');
}
