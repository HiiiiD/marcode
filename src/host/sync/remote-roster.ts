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

export async function readEntries(root: string, deviceId: string): Promise<Record<string, MirrorEntry>> {
  const file = await readJson<{ entries?: Record<string, MirrorEntry> }>(path.join(mirrorStoreDir(root, deviceId), SESSIONS_FILE));
  return typeof file?.entries === 'object' && file.entries !== null ? file.entries : {};
}

/** Every host's view of the mirror; missing or torn files read as empty. */
export async function readRemoteRoster(root: string): Promise<{ rows: RemoteRow[]; devices: DevicePresence[] }> {
  const devices = await readJson<DevicePresence[]>(path.join(root, DEVICES_FILE));
  const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const rows: RemoteRow[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) { continue; }
    const deviceId = decodeURIComponent(dir.name);
    for (const entry of Object.values(await readEntries(root, deviceId))) {
      if (!entry.state || entry.projectId === undefined || entry.relCwd === undefined) { continue; }
      rows.push({
        deviceId, state: entry.state, projectId: entry.projectId, relCwd: entry.relCwd, rev: entry.rev,
        ...(entry.branch ? { branch: entry.branch } : {}), ...(entry.gap ? { gap: true as const } : {}),
      });
    }
  }
  return { rows, devices: Array.isArray(devices) ? devices : [] };
}
