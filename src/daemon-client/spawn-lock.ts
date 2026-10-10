import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createExclusive } from '../host/atomic-file';
import { defaultLeaseDeps } from '../host/lease';

interface SpawnLockOpts {
  staleMs?: number;
  pidAlive?: (pid: number) => boolean;
  now?: () => number;
}

const TAKEOVER_STALE_MS = 5_000;

interface LockBody { pid: number; at: number }

async function readRaw(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, 'utf8'); } catch { return undefined; }
}

function parse(raw: string | undefined): LockBody | undefined {
  if (raw === undefined) { return undefined; }
  try {
    const v = JSON.parse(raw) as Record<string, unknown> | null;
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
  const takeoverFile = `${file}.takeover`;
  const at = now();
  const body = JSON.stringify({ pid: process.pid, at });
  const isLive = (held: LockBody | undefined): boolean =>
    held !== undefined && pidAlive(held.pid) && now() - held.at <= staleMs;

  const releaser = (): (() => Promise<void>) => {
    let released = false;
    return async () => {
      if (released) { return; }
      released = true;
      const held = parse(await readRaw(file));
      if (held?.pid !== process.pid || held.at !== at) { return; }
      await fs.rm(file, { force: true }).catch(() => { /* best effort */ });
    };
  };

  try {
    if (await createExclusive(file, body)) { return releaser(); }

    const judged = await readRaw(file);
    if (isLive(parse(judged))) { return undefined; }

    if (!(await createExclusive(takeoverFile, body))) {
      const taker = parse(await readRaw(takeoverFile));
      if (!taker || now() - taker.at > TAKEOVER_STALE_MS || !pidAlive(taker.pid)) {
        await fs.rm(takeoverFile, { force: true });
      }
      return undefined;
    }

    try {
      const current = await readRaw(file);
      if (current !== judged && isLive(parse(current))) { return undefined; }
      await fs.rm(file, { force: true });
      return (await createExclusive(file, body)) ? releaser() : undefined;
    } finally {
      await fs.rm(takeoverFile, { force: true }).catch(() => { /* best effort */ });
    }
  } catch {
    return undefined;
  }
}
