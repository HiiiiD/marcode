import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PublishedState } from '../../sync/session-records';

export interface RemoteRow { deviceId: string; state: PublishedState; projectId: string; relCwd: string; branch?: string; rev: number; gap?: true }
export interface DevicePresence { deviceId: string; name: string; online: boolean; lastSeenAt: number; newerFormat?: true }

/** One mirrored session as stored: ops may arrive before its meta, so everything but `rev` is optional. */
export interface MirrorEntry { state?: PublishedState; projectId?: string; relCwd?: string; branch?: string; rev: number; gap?: true }

export const SESSIONS_FILE = 'sessions.json';
export const DEVICES_FILE = 'devices.json';

export function mirrorStoreDir(root: string, deviceId: string): string {
  return path.join(root, encodeURIComponent(deviceId));
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch { return undefined; }
}

/** A device's entries: `{}` when it has none yet, `undefined` when the file is there but cannot be read. */
export async function readEntries(root: string, deviceId: string): Promise<Record<string, MirrorEntry> | undefined> {
  let text: string;
  try {
    text = await fs.readFile(path.join(mirrorStoreDir(root, deviceId), SESSIONS_FILE), 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? {} : undefined;
  }
  try {
    const file = JSON.parse(text) as { entries?: Record<string, MirrorEntry> };
    return typeof file.entries === 'object' && file.entries !== null ? file.entries : {};
  } catch {
    return undefined;
  }
}

/**
 * Every host's view of the mirror; a missing mirror reads as empty. `unreadable` names the devices whose
 * file could not be read this time (`'*'` for the whole mirror): that says nothing about their sessions.
 */
export async function readRemoteRoster(root: string): Promise<{ rows: RemoteRow[]; devices: DevicePresence[]; unreadable: string[] }> {
  const devices = await readJson<DevicePresence[]>(path.join(root, DEVICES_FILE));
  const unreadable: string[] = [];
  const dirs = await fs.readdir(root, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') { unreadable.push('*'); }
    return [];
  });
  const rows: RemoteRow[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) { continue; }
    const deviceId = decodeURIComponent(dir.name);
    const entries = await readEntries(root, deviceId);
    if (!entries) { unreadable.push(deviceId); continue; }
    for (const entry of Object.values(entries)) {
      if (!entry.state || entry.projectId === undefined || entry.relCwd === undefined) { continue; }
      rows.push({
        deviceId, state: entry.state, projectId: entry.projectId, relCwd: entry.relCwd, rev: entry.rev,
        ...(entry.branch ? { branch: entry.branch } : {}), ...(entry.gap ? { gap: true as const } : {}),
      });
    }
  }
  return { rows, devices: Array.isArray(devices) ? devices : [], unreadable };
}
