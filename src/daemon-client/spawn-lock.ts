import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createExclusive } from '../host/atomic-file';
import { defaultLeaseDeps } from '../host/lease';

interface SpawnLockOpts {
  staleMs?: number;
  pidAlive?: (pid: number) => boolean;
  now?: () => number;
}

async function readLock(file: string): Promise<{ pid: number; at: number } | undefined> {
  try {
    const v = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    return typeof v?.pid === 'number' && typeof v.at === 'number' ? { pid: v.pid, at: v.at } : undefined;
  } catch {
    return undefined;
  }
}

export async function acquireSpawnLock(
  dir: string,
  opts: SpawnLockOpts = {},
): Promise<(() => Promise<void>) | undefined> {
  const { staleMs = 30_000, pidAlive = defaultLeaseDeps.pidAlive, now = () => Date.now() } = opts;
  const file = path.join(dir, 'daemon.lock');
  const body = JSON.stringify({ pid: process.pid, at: now() });

  try {
    if (!(await createExclusive(file, body))) {
      const held = await readLock(file);
      if (held && pidAlive(held.pid) && now() - held.at <= staleMs) { return undefined; }
      await fs.rm(file, { force: true });
      if (!(await createExclusive(file, body))) { return undefined; }
    }
  } catch {
    return undefined;
  }

  let released = false;
  return async () => {
    if (released) { return; }
    released = true;
    if ((await readLock(file))?.pid !== process.pid) { return; }
    await fs.rm(file, { force: true }).catch(() => { /* best effort */ });
  };
}
