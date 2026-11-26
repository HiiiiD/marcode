import type { SessionDigest } from '../../memory/digest';
import type { DigestMeta, MemoryDetail, MemoryHit, MemoryStore, SearchOpts, SessionRecord } from '../../memory/types';
import type { SessionId, TranscriptItem } from '../../protocol/messages';
import { isShareableProject, memoryPayload } from '../../sync/memory-records';
import type { SyncState } from '../../sync/sync-state';

interface PublisherSession { id: SessionId; providerId: string; cwd: string; projectId?: string; hidden: boolean }

export interface MemoryPublisherDeps {
  inner: MemoryStore;
  state: SyncState;
  excluded: string[];
  relCwd: (cwd: string) => Promise<string>;
  transcript: (id: SessionId) => Promise<TranscriptItem[]>;
  sessions: () => PublisherSession[];
}

/**
 * The memory store every host uses once sync is on: local behaviour is unchanged, and each index
 * or forget of a shareable session also lands in the machine-wide outbox the sync engine pushes.
 */
export class MemoryPublisher implements MemoryStore {
  /** Per session, so a withdraw can never be queued ahead of a memory record still being built. */
  private readonly chains = new Map<SessionId, Promise<unknown>>();

  constructor(private readonly deps: MemoryPublisherDeps) {}

  private serial<T>(id: SessionId, work: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(id) ?? Promise.resolve()).then(work, work);
    const settled = next.catch(() => undefined);
    this.chains.set(id, settled);
    void settled.then(() => { if (this.chains.get(id) === settled) { this.chains.delete(id); } });
    return next;
  }

  async index(record: SessionRecord): Promise<void> {
    await this.deps.inner.index(record);
    await this.serial(record.sessionId, async () => {
      const digest = record.digest ?? await this.deps.inner.getDigest(record.sessionId).catch(() => undefined);
      if (digest) { await this.publish(record, digest); }
    });
  }

  async forget(sessionId: SessionId): Promise<void> {
    await this.deps.inner.forget(sessionId);
    await this.serial(sessionId, async () => {
      this.safely(() => {
        this.deps.state.enqueue({ type: 'memory-withdraw', sessionId });
        this.deps.state.clearPublished(sessionId);
      });
    });
  }

  async setProject(sessionId: SessionId, projectId: string): Promise<void> {
    await this.deps.inner.setProject?.(sessionId, projectId);
    const session = this.deps.sessions().find((s) => s.id === sessionId);
    if (session?.hidden) { await this.serial(sessionId, () => this.publishStored({ ...session, projectId })); }
  }

  /** Hidden, shareable sessions whose stored digest was never published: what existed before pairing. */
  async backfill(): Promise<number> {
    let count = 0;
    for (const session of this.deps.sessions()) {
      if (session.hidden && await this.serial(session.id, () => this.publishStored(session))) { count++; }
    }
    return count;
  }

  search(query: string, opts?: SearchOpts): Promise<MemoryHit[]> { return this.deps.inner.search(query, opts); }
  fetch(hit: { sessionId: SessionId; itemId: string }): Promise<MemoryDetail> { return this.deps.inner.fetch(hit); }
  getDigest(sessionId: SessionId): Promise<SessionDigest | undefined> { return this.deps.inner.getDigest(sessionId); }
  digestMeta(): Promise<Map<SessionId, DigestMeta>> { return this.deps.inner.digestMeta(); }

  private async publishStored(session: PublisherSession): Promise<boolean> {
    if (!isShareableProject(session.projectId, this.deps.excluded)) { return false; }
    const digest = await this.deps.inner.getDigest(session.id).catch(() => undefined);
    if (!digest) { return false; }
    if (this.safelyRead(() => this.deps.state.wasPublished(session.id, digest))) { return false; }
    const items = await this.deps.transcript(session.id).catch(() => [] as TranscriptItem[]);
    return this.publish({
      sessionId: session.id, providerId: session.providerId, cwd: session.cwd, closedAt: digest.forUpdatedAt, items, projectId: session.projectId,
    }, digest);
  }

  private async publish(record: SessionRecord, digest: SessionDigest): Promise<boolean> {
    const projectId = record.projectId;
    if (!isShareableProject(projectId, this.deps.excluded)) { return false; }
    try {
      if (this.deps.state.wasPublished(record.sessionId, digest)) { return false; }
      const payload = memoryPayload({ record, projectId, relCwd: await this.deps.relCwd(record.cwd), digest });
      if (!payload) { return false; }
      // Re-checked after the awaits above: a session shown again meanwhile must not be published.
      if (this.deps.sessions().find((s) => s.id === record.sessionId)?.hidden === false) { return false; }
      this.deps.state.enqueue(payload);
      this.deps.state.markPublished(record.sessionId, digest);
      return true;
    } catch (err) {
      console.error('[mar-code] sync: could not queue memory for', record.sessionId, err);
      return false;
    }
  }

  private safelyRead(read: () => boolean): boolean {
    try { return read(); } catch { return false; }
  }

  private safely(work: () => void): void {
    try { work(); } catch (err) { console.error('[mar-code] sync: could not queue a withdraw', err); }
  }
}
