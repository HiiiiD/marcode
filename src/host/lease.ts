import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { createExclusive, writeFileAtomic } from './atomic-file';

export const HEARTBEAT_MS = 5_000;
export const STALE_MS = 20_000;

export type LeaseHost = 'vscode' | 'tui';

export interface LeaseInfo {
  pid: number;
  host: LeaseHost;
  instance: string;
  machine: string;
  heartbeat: number;
}

export interface LeaseDeps {
  now(): number;
  pidAlive(pid: number): boolean;
  machine: string;
}

export const defaultLeaseDeps: LeaseDeps = {
  now: () => Date.now(),
  pidAlive: (pid) => {
    try { process.kill(pid, 0); return true; } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  machine: os.hostname(),
};

function isLeaseInfo(value: unknown): value is LeaseInfo {
  if (typeof value !== 'object' || value === null) { return false; }
  const v = value as Record<string, unknown>;
  return typeof v.pid === 'number' && typeof v.instance === 'string' && typeof v.machine === 'string'
    && typeof v.heartbeat === 'number' && (v.host === 'vscode' || v.host === 'tui');
}

export async function readLease(file: string): Promise<LeaseInfo | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return isLeaseInfo(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The pid probe only speaks for this machine: a shared home can be read from several. */
export function isStale(info: LeaseInfo, deps: LeaseDeps): boolean {
  if (deps.now() - info.heartbeat > STALE_MS) { return true; }
  return info.machine === deps.machine && !deps.pidAlive(info.pid);
}

export class HeldLease {
  constructor(
    private readonly file: string,
    readonly info: LeaseInfo,
    private readonly deps: LeaseDeps,
  ) {}

  async beat(): Promise<boolean> {
    const current = await readLease(this.file);
    if (current?.instance !== this.info.instance) { return false; }
    await writeFileAtomic(this.file, JSON.stringify({ ...this.info, heartbeat: this.deps.now() }));
    return true;
  }

  async release(): Promise<void> {
    const current = await readLease(this.file);
    if (current?.instance === this.info.instance) { await fs.rm(this.file, { force: true }); }
  }
}

export type Claim = { ok: true; lease: HeldLease } | { ok: false; owner: LeaseInfo };

export async function claimLease(
  file: string,
  self: { host: LeaseHost; instance: string },
  deps: LeaseDeps = defaultLeaseDeps,
): Promise<Claim> {
  const info: LeaseInfo = {
    pid: process.pid, host: self.host, instance: self.instance, machine: deps.machine, heartbeat: deps.now(),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await createExclusive(file, JSON.stringify(info))) { return { ok: true, lease: new HeldLease(file, info, deps) }; }
    const current = await readLease(file);
    if (current?.instance === self.instance) { return { ok: true, lease: new HeldLease(file, current, deps) }; }
    if (current && !isStale(current, deps)) { return { ok: false, owner: current }; }
    await fs.rm(file, { force: true });
  }
  const last = await readLease(file);
  if (last) { return { ok: false, owner: last }; }
  throw new Error(`could not claim lease ${file}`);
}
