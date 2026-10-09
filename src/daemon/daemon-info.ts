import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomic } from '../host/atomic-file';

export interface DaemonInfo {
  pid: number;
  endpoint: string;
  token: string;
  protocolVersion: number;
  appVersion: string;
  startedAt: number;
}

export const daemonInfoPath = (dir: string): string => path.join(dir, 'daemon.json');
export const newToken = (): string => randomBytes(24).toString('hex');

function isInfo(v: unknown): v is DaemonInfo {
  if (typeof v !== 'object' || v === null) { return false; }
  const o = v as Record<string, unknown>;
  return typeof o.pid === 'number' && typeof o.endpoint === 'string' && typeof o.token === 'string'
    && typeof o.protocolVersion === 'number' && typeof o.appVersion === 'string' && typeof o.startedAt === 'number';
}

export async function readDaemonInfo(dir: string): Promise<DaemonInfo | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(daemonInfoPath(dir), 'utf8'));
    return isInfo(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeDaemonInfo(dir: string, info: DaemonInfo): Promise<void> {
  await writeFileAtomic(daemonInfoPath(dir), JSON.stringify(info));
  await fs.chmod(daemonInfoPath(dir), 0o600).catch(() => { /* no POSIX modes on some Windows filesystems */ });
}

export async function removeDaemonInfo(dir: string, pid: number): Promise<void> {
  if ((await readDaemonInfo(dir))?.pid !== pid) { return; }
  await fs.rm(daemonInfoPath(dir), { force: true });
}
