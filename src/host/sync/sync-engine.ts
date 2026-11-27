import * as path from 'node:path';
import type { RemoteMemory } from '../../memory/remote-memory';
import { readCredentials, type SyncCredentials } from '../../sync/credentials';
import { REVOKED_ERROR } from '../../sync/http';
import { parseMemoryPayload } from '../../sync/memory-records';
import { parseSessionPayload } from '../../sync/session-records';
import { SyncClient, type SyncClientOptions } from '../../sync/sync-client';
import type { SyncState } from '../../sync/sync-state';
import type { LeaseHost } from '../lease';
import { SessionOwnership } from '../session-ownership';
import type { SessionMirror } from './session-mirror';

export interface SyncEngineDeps {
  home: string;
  hostKind: LeaseHost;
  state: SyncState;
  /** Absent while memory is off: memory records are then skipped, and the cursor moves past them. */
  remote?: RemoteMemory;
  mirror?: SessionMirror;
  clientOptions?: SyncClientOptions;
  pollMs?: number;
  claimRetryMs?: number;
  /** Bytes of plaintext per push request; the server refuses bodies over 8 MiB. */
  pushBytes?: number;
  pageSize?: number;
}

const LEASE = 'sync-engine';
const PUSH_TICK_MS = 500;
const REJECTED = /answered (400|413)\b/;

/**
 * One per machine, chosen by a lease: pushes the shared outbox and imports the other devices' streams
 * into `RemoteMemory`. Credentials are re-read every cycle, so a rotated key is used at once.
 */
export class SyncEngine {
  private readonly ownership: SessionOwnership;
  private holding = false;
  private disposed = false;
  private follower: { stop(): void } | undefined;
  private timers: NodeJS.Timeout[] = [];
  private claimTimer: NodeJS.Timeout | undefined;
  private pushing = false;
  private pulling: Promise<void> | undefined;
  private pullAgain = false;
  private counts = { pushed: 0, applied: 0, skipped: 0, failed: 0 };

  constructor(private readonly deps: SyncEngineDeps) {
    this.ownership = new SessionOwnership(path.join(deps.home, 'sync'), deps.hostKind);
    this.ownership.onLost(() => { this.release(); this.scheduleClaim(); });
  }

  stats(): { pushed: number; applied: number; skipped: number; failed: number; holding: boolean } {
    return { ...this.counts, holding: this.holding };
  }

  start(): void {
    void this.claim();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.claimTimer) { clearTimeout(this.claimTimer); }
    this.release();
    await this.ownership.dispose().catch(() => { /* best effort */ });
  }

  private scheduleClaim(): void {
    if (this.disposed) { return; }
    if (this.claimTimer) { clearTimeout(this.claimTimer); }
    this.claimTimer = setTimeout(() => { void this.claim(); }, this.deps.claimRetryMs ?? 30_000);
    this.claimTimer.unref();
  }

  private async claim(): Promise<void> {
    if (this.disposed || this.holding) { return; }
    const creds = await readCredentials(this.deps.home);
    if (!creds) { this.scheduleClaim(); return; }
    const owned = await this.ownership.claim(LEASE).then((c) => c.owned, () => false);
    if (!owned || this.disposed) { this.scheduleClaim(); return; }
    this.holding = true;
    // Another host may have held the lease since this one last did, and written the mirror meanwhile.
    this.deps.mirror?.reset();
    this.follower = new SyncClient(creds, this.deps.clientOptions).follow((event) => {
      if (event.type === 'appended') { void this.pull(); }
      if (event.type === 'devices') { void this.presence(); }
      if (event.type === 'connection' && event.state === 'open') { void this.pull(); }
      if (event.type === 'connection' && event.state === 'revoked') { void this.stop(); }
    });
    this.every(PUSH_TICK_MS, () => { void this.push(); });
    this.every(this.deps.pollMs ?? 300_000, () => { void this.pull(); });
    void this.push();
    void this.pull();
    void this.presence();
  }

  /** Who is online, for the roster's device labels; a failure leaves the last known state. */
  private async presence(): Promise<void> {
    if (!this.holding || !this.deps.mirror) { return; }
    try {
      const session = await this.client();
      if (!session) { return; }
      const devices = await session.client.devices();
      if (!devices.ok) { return; }
      await this.deps.mirror.setDevices(devices.value.filter((d) => d.deviceId !== session.creds.deviceId)
        .map((d) => ({ deviceId: d.deviceId, name: d.name, online: d.online === true, lastSeenAt: d.lastSeenAt })));
      await this.deps.mirror.flush();
    } catch (err) {
      console.error('[mar-code] sync: presence failed', err);
    }
  }

  private every(ms: number, work: () => void): void {
    const timer = setInterval(work, ms);
    timer.unref();
    this.timers.push(timer);
  }

  private release(): void {
    this.holding = false;
    this.follower?.stop();
    this.follower = undefined;
    for (const t of this.timers) { clearInterval(t); }
    this.timers = [];
  }

  private async stop(): Promise<void> {
    this.release();
    await this.ownership.release(LEASE).catch(() => { /* already gone */ });
    this.scheduleClaim();
  }

  /** Fresh credentials for one cycle; a missing file or a revoked token ends this engine's turn. */
  private async client(): Promise<{ client: SyncClient; creds: SyncCredentials } | undefined> {
    const creds = await readCredentials(this.deps.home);
    if (!creds) { await this.stop(); return undefined; }
    return { client: new SyncClient(creds, this.deps.clientOptions), creds };
  }

  private async push(): Promise<void> {
    if (!this.holding || this.pushing || this.deps.state.outboxSize() === 0) { return; }
    this.pushing = true;
    try {
      const session = await this.client();
      if (!session) { return; }
      for (;;) {
        const batch = this.nextBatch();
        if (batch.length === 0) { return; }
        const result = await session.client.pushRecords(batch);
        if (result.ok) {
          this.deps.state.remove(batch.map((r) => r.recordId));
          this.counts.pushed += batch.length;
          continue;
        }
        if (result.error === REVOKED_ERROR) { await this.stop(); return; }
        if (!REJECTED.test(result.error)) { return; }
        // A refused batch: send it one at a time so the one record the server will not take is dropped alone.
        for (const row of batch) {
          const one = await session.client.pushRecords([row]);
          if (one.ok) { this.counts.pushed++; } else if (REJECTED.test(one.error)) { this.counts.skipped++; } else { return; }
          this.deps.state.remove([row.recordId]);
        }
      }
    } catch (err) {
      console.error('[mar-code] sync: push failed', err);
    } finally {
      this.pushing = false;
    }
  }

  private nextBatch(): Array<{ recordId: string; payload: unknown }> {
    // The server caps a body at 8 MiB of JSON; ciphertext is base64 (4/3) plus per-record framing.
    const limit = this.deps.pushBytes ?? 5.5 * 1024 * 1024;
    const batch: Array<{ recordId: string; payload: unknown }> = [];
    let size = 0;
    for (const row of this.deps.state.peek(200)) {
      const bytes = Math.ceil(Buffer.byteLength(JSON.stringify(row.payload)) * 4 / 3) + 512;
      if (batch.length > 0 && size + bytes > limit) { break; }
      batch.push(row);
      size += bytes;
    }
    return batch;
  }

  private pull(): Promise<void> {
    if (!this.holding) { return Promise.resolve(); }
    if (this.pulling) { this.pullAgain = true; return this.pulling; }
    this.pulling = this.pullOnce()
      .catch((err: unknown) => { console.error('[mar-code] sync: pull failed', err); })
      .finally(() => {
        this.pulling = undefined;
        if (this.pullAgain) { this.pullAgain = false; void this.pull(); }
      });
    return this.pulling;
  }

  private async pullOnce(): Promise<void> {
    const session = await this.client();
    if (!session) { return; }
    const streams = await session.client.streams();
    if (!streams.ok) {
      if (streams.error === REVOKED_ERROR) { await this.stop(); }
      return;
    }
    for (const stream of streams.value) {
      if (stream.deviceId === session.creds.deviceId) { continue; }
      let cursor = this.deps.state.cursor(stream.deviceId);
      let waiting = false;
      while (this.holding && !waiting && cursor < stream.lastSeq) {
        const page = await session.client.pull(stream.deviceId, cursor, this.deps.pageSize ?? 500);
        if (!page.ok || page.value.length === 0) { break; }
        for (const record of page.value) {
          // A key not yet sealed for this device may arrive later; skipping now would lose the record for good.
          if (record.missingKey) { waiting = true; break; }
          const outcome = await this.applyRecord(stream.deviceId, record.unreadable ? undefined : record.payload);
          // A transcript op that failed to apply is retried next cycle: skipping it would leave a hole for good.
          if (outcome === 'failed') { waiting = true; break; }
          this.counts[outcome]++;
          cursor = record.seq;
        }
        // The mirror only buffers until flushed; the cursor must never pass ops still in memory.
        await this.deps.mirror?.flush();
        this.deps.state.setCursor(stream.deviceId, cursor);
      }
    }
    void this.presence();
  }

  private async applyRecord(deviceId: string, raw: unknown): Promise<'applied' | 'skipped' | 'failed'> {
    const memory = raw === undefined ? undefined : parseMemoryPayload(raw);
    if (memory) {
      if (!this.deps.remote) { return 'skipped'; }
      // A memory row is a cache: one that will not apply is dropped, as before.
      return this.deps.remote.apply(deviceId, memory).then(() => 'applied' as const, () => 'skipped' as const);
    }
    const session = raw === undefined ? undefined : parseSessionPayload(raw);
    if (!session || !this.deps.mirror) { return 'skipped'; }
    if ('newerFormat' in session) { this.deps.mirror.markNewerFormat(deviceId); return 'skipped'; }
    try {
      await this.deps.mirror.apply(deviceId, session);
      return 'applied';
    } catch (err) {
      console.error('[mar-code] sync: could not mirror a session record', err);
      this.counts.failed++;
      return 'failed';
    }
  }
}
