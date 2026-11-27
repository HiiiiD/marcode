import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { OwnerRecord } from '../../sync/api-types';
import { assemble, type MoveReplyPayload, type MoveRequestPayload } from '../../sync/move-records';
import type { PublishedState } from '../../sync/session-records';

export interface RemoteRow { deviceId: string; state: PublishedState; projectId: string; relCwd: string; branch?: string; rev: number; gap?: true }
export interface DevicePresence { deviceId: string; name: string; online: boolean; lastSeenAt: number; newerFormat?: true }

/** One mirrored session as stored: ops may arrive before its meta, so everything but `rev` is optional. */
export interface MirrorEntry { state?: PublishedState; projectId?: string; relCwd?: string; branch?: string; rev: number; gap?: true }

export const SESSIONS_FILE = 'sessions.json';
export const DEVICES_FILE = 'devices.json';
export const OWNERS_FILE = 'owners.json';
export const INBOX_DIR = 'inbox';

export interface InboxMessage { from: string; payload: MoveRequestPayload | MoveReplyPayload }

/** One chunk on disk: `<offset>-<total>.bin` under `threads/<session>/<name>/<generation>/`. */
export const chunkFileName = (offset: number, total: number): string => `${offset}-${total}.bin`;

export function threadDir(root: string, deviceId: string, sessionId: string): string {
  return path.join(mirrorStoreDir(root, deviceId), 'threads', encodeURIComponent(sessionId));
}

export function attachmentDir(root: string, deviceId: string, sessionId: string): string {
  return path.join(mirrorStoreDir(root, deviceId), 'attachments', encodeURIComponent(sessionId));
}

const dirs = async (dir: string): Promise<string[]> =>
  (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name);

/** The bytes of the newest generation under `dir`, once complete. */
export async function readChunks(dir: string): Promise<{ generation: number; bytes: Buffer } | undefined> {
  const generations = (await dirs(dir)).map(Number).filter(Number.isSafeInteger);
  if (generations.length === 0) { return undefined; }
  const generation = Math.max(...generations);
  const at = path.join(dir, String(generation));
  const chunks = [];
  for (const name of await fs.readdir(at).catch(() => [] as string[])) {
    const m = /^(\d+)-(\d+)\.bin$/.exec(name);
    if (!m) { continue; }
    const data = await fs.readFile(path.join(at, name)).catch(() => undefined);
    if (data) { chunks.push({ generation, offset: Number(m[1]), total: Number(m[2]), data: data.toString('base64') }); }
  }
  const bytes = assemble(chunks);
  return bytes ? { generation, bytes } : undefined;
}

/** A mirrored session's native-thread files, only when every one of them is complete. */
export async function readThread(root: string, deviceId: string, sessionId: string): Promise<Array<{ name: string; generation: number; bytes: Buffer }> | undefined> {
  const base = threadDir(root, deviceId, sessionId);
  const names = await dirs(base);
  if (names.length === 0) { return undefined; }
  const files = [];
  for (const name of names) {
    const file = await readChunks(path.join(base, name));
    if (!file) { return undefined; }
    files.push({ name: decodeURIComponent(name), ...file });
  }
  return files;
}

export async function readInbox(root: string): Promise<InboxMessage[]> {
  const dir = path.join(root, INBOX_DIR);
  const out: InboxMessage[] = [];
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const message = await readJson<InboxMessage>(path.join(dir, name));
    if (message?.payload) { out.push(message); }
  }
  return out;
}

export async function removeInbox(root: string, requestId: string): Promise<void> {
  const dir = path.join(root, INBOX_DIR);
  for (const kind of ['request', 'reply']) {
    await fs.rm(path.join(dir, `${encodeURIComponent(requestId)}.${kind}.json`), { force: true });
  }
}

export async function readOwners(root: string): Promise<Map<string, OwnerRecord>> {
  const list = await readJson<OwnerRecord[]>(path.join(root, OWNERS_FILE));
  return new Map((Array.isArray(list) ? list : []).map((o) => [o.key, o]));
}

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
