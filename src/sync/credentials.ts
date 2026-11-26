import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DeviceKeys } from './crypto';

export interface SyncCredentials {
  server: string;
  deviceId: string;
  deviceName: string;
  token: string;
  keys: DeviceKeys;
  /** Every key epoch this device can read, oldest first; new records use the last. */
  syncKeys: Array<{ epoch: number; key: string }>;
}

export function credentialsPath(home: string): string {
  return path.join(home, 'sync', 'credentials.json');
}

function isCredentials(v: unknown): v is SyncCredentials {
  const c = v as Partial<SyncCredentials> | null;
  return typeof c === 'object' && c !== null && typeof c.server === 'string' && typeof c.deviceId === 'string'
    && typeof c.token === 'string' && typeof c.keys?.privateKey === 'string' && Array.isArray(c.syncKeys);
}

export async function readCredentials(home: string): Promise<SyncCredentials | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(credentialsPath(home), 'utf8'));
    return isCredentials(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Written with 0600 then chmod-ed, as `daemon.json` is: the file holds the device token and every sync key. */
export async function writeCredentials(home: string, creds: SyncCredentials): Promise<void> {
  const file = credentialsPath(home);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(tmp, 0o600).catch(() => { /* not supported on this filesystem */ });
  await fs.rename(tmp, file);
}

export async function removeCredentials(home: string): Promise<void> {
  await fs.rm(credentialsPath(home), { force: true });
}
