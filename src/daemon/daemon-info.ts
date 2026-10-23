import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface DaemonInfo {
  pid: number;
  endpoint: string;
  token: string;
  protocolVersion: number;
  appVersion: string;
  startedAt: number;
  /** reloadSignature of the config.json the daemon started with; absent from older daemons. */
  configSignature?: string;
}

export const daemonInfoPath = (dir: string): string => path.join(dir, 'daemon.json');
export const newToken = (): string => randomBytes(24).toString('hex');

function isInfo(v: unknown): v is DaemonInfo {
  if (typeof v !== 'object' || v === null) { return false; }
  const o = v as Record<string, unknown>;
  return typeof o.pid === 'number' && typeof o.endpoint === 'string' && typeof o.token === 'string'
    && typeof o.protocolVersion === 'number' && typeof o.appVersion === 'string' && typeof o.startedAt === 'number'
    && (o.configSignature === undefined || typeof o.configSignature === 'string');
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const ATTEMPTS = 5;
const STEP_MS = 25;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A rename over a file another process holds open fails with EPERM on Windows, so this file is
// rewritten in place. A reader can land between truncate and write, hence the re-read below.
export async function readDaemonInfo(dir: string): Promise<DaemonInfo | undefined> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(daemonInfoPath(dir), 'utf8'));
      if (isInfo(parsed)) { return parsed; }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
    }
    await pause(STEP_MS);
  }
  return undefined;
}

export async function writeDaemonInfo(dir: string, info: DaemonInfo): Promise<void> {
  const file = daemonInfoPath(dir);
  await fs.mkdir(dir, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.writeFile(file, JSON.stringify(info), { encoding: 'utf8', mode: 0o600 });
      break;
    } catch (err) {
      if (attempt >= ATTEMPTS - 1 || !RETRYABLE.has((err as NodeJS.ErrnoException).code ?? '')) { throw err; }
      await pause(STEP_MS * (attempt + 1));
    }
  }
  await fs.chmod(file, 0o600).catch(() => { /* no POSIX modes on some Windows filesystems */ });
}

export async function removeDaemonInfo(dir: string, pid: number): Promise<void> {
  if ((await readDaemonInfo(dir))?.pid !== pid) { return; }
  await fs.rm(daemonInfoPath(dir), { force: true });
}
