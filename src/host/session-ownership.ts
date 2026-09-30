import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  claimLease, defaultLeaseDeps, HEARTBEAT_MS, isStale, readLease,
  type HeldLease, type LeaseDeps, type LeaseHost,
} from './lease';

export interface OwnerInfo { host: LeaseHost; pid: number }
export type OwnClaim = { owned: true } | { owned: false; owner: OwnerInfo };

export class SessionOwnership {
  private readonly held = new Map<string, HeldLease>();
  private readonly deps: LeaseDeps;
  private readonly instance: string;
  private readonly heartbeatMs: number;
  private timer?: NodeJS.Timeout;
  private lost: (id: string) => void = () => {};

  constructor(
    private readonly dir: string,
    private readonly host: LeaseHost,
    opts: { deps?: LeaseDeps; instance?: string; heartbeatMs?: number } = {},
  ) {
    this.deps = opts.deps ?? defaultLeaseDeps;
    this.instance = opts.instance ?? randomUUID();
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  }

  onLost(cb: (id: string) => void): void { this.lost = cb; }

  owns(id: string): boolean { return this.held.has(id); }

  private file(id: string): string { return path.join(this.dir, `${id}.lock`); }

  async claim(id: string): Promise<OwnClaim> {
    if (this.held.has(id)) { return { owned: true }; }
    const result = await claimLease(this.file(id), { host: this.host, instance: this.instance }, this.deps);
    if (!result.ok) { return { owned: false, owner: { host: result.owner.host, pid: result.owner.pid } }; }
    this.held.set(id, result.lease);
    this.startTimer();
    return { owned: true };
  }

  async ownerOf(id: string): Promise<OwnerInfo | undefined> {
    if (this.held.has(id)) { return undefined; }
    const info = await readLease(this.file(id), this.deps.readFile);
    if (!info || isStale(info, this.deps)) { return undefined; }
    return { host: info.host, pid: info.pid };
  }

  async release(id: string): Promise<void> {
    const lease = this.held.get(id);
    if (!lease) { return; }
    this.held.delete(id);
    if (this.held.size === 0) { this.stopTimer(); }
    await lease.release();
  }

  async dispose(): Promise<void> {
    this.stopTimer();
    const leases = [...this.held.values()];
    this.held.clear();
    await Promise.all(leases.map((l) => l.release()));
  }

  private startTimer(): void {
    if (this.timer) { return; }
    this.timer = setInterval(() => { void this.beatAll(); }, this.heartbeatMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  private async beatAll(): Promise<void> {
    for (const [id, lease] of [...this.held]) {
      let alive = true;
      try { alive = await lease.beat(); } catch { /* a transient fs error is not a lost lease */ }
      if (!alive) {
        this.held.delete(id);
        this.lost(id);
      }
    }
    if (this.held.size === 0) { this.stopTimer(); }
  }
}
