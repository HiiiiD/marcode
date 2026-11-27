import type { SessionId, SessionState } from '../../protocol/messages';
import { isShareableProject } from '../../sync/memory-records';
import { opsPayloads, publishedState, type TranscriptOp } from '../../sync/session-records';
import type { SyncState } from '../../sync/sync-state';
import type { TranscriptStore } from '../transcript-store';

export interface SessionPublisherDeps {
  store: TranscriptStore;
  state: SyncState;
  excluded: string[];
  /** The session when this host owns it and it may sync (not a side chat, subagent or remote row). */
  publishable: (id: SessionId) => SessionState | undefined;
  relCwd: (cwd: string) => Promise<string>;
  branch: (cwd: string) => Promise<string | undefined>;
}

/**
 * Sends the sessions this host owns to the machine-wide outbox: metadata when what other devices
 * see changes, every transcript write once it is on disk, and a tombstone on delete.
 */
export class SessionPublisher {
  private readonly chains = new Map<SessionId, Promise<unknown>>();
  private unsubscribe: Array<() => void> = [];

  constructor(private readonly deps: SessionPublisherDeps) {}

  start(): void {
    this.unsubscribe = [
      this.deps.store.onWritten((id, ops) => { void this.serial(id, () => this.written(id, ops)); }),
      this.deps.store.onRemoved((id) => { void this.serial(id, async () => this.removed(id)); }),
    ];
  }

  dispose(): void {
    for (const off of this.unsubscribe) { off(); }
    this.unsubscribe = [];
  }

  async publishMeta(states: SessionState[]): Promise<void> {
    await Promise.all(states.map((s) => this.serial(s.id, () => this.meta(s.id))));
  }

  /** Sessions never sent in full (they predate pairing): meta and the whole transcript, once each. */
  async backfill(states: SessionState[]): Promise<number> {
    let count = 0;
    for (const s of states) {
      if (await this.serial(s.id, () => this.full(s.id))) { count++; }
    }
    return count;
  }

  private serial<T>(id: SessionId, work: () => Promise<T>): Promise<T | undefined> {
    const guarded = async (): Promise<T | undefined> => {
      try { return await work(); } catch (err) {
        console.error('[mar-code] sync: could not queue session', id, err);
        return undefined;
      }
    };
    const next = (this.chains.get(id) ?? Promise.resolve()).then(guarded);
    this.chains.set(id, next);
    void next.then(() => { if (this.chains.get(id) === next) { this.chains.delete(id); } });
    return next;
  }

  private shareable(id: SessionId): SessionState | undefined {
    const state = this.deps.publishable(id);
    return state && isShareableProject(state.projectId, this.deps.excluded) ? state : undefined;
  }

  private async written(id: SessionId, ops: TranscriptOp[]): Promise<void> {
    if (!this.shareable(id)) { return; }
    // A session's first write after pairing sends everything before it too; the ops are in there.
    if (!this.deps.state.wasBackfilled(id)) { await this.full(id); return; }
    this.enqueueOps(id, ops);
  }

  private async full(id: SessionId): Promise<boolean> {
    if (!this.shareable(id) || this.deps.state.wasBackfilled(id)) { return false; }
    await this.meta(id);
    const { items } = await this.deps.store.tail(id, Number.MAX_SAFE_INTEGER);
    this.enqueueOps(id, items.map((item): TranscriptOp => ({ op: 'append', item })));
    this.deps.state.markBackfilled(id);
    return true;
  }

  private enqueueOps(id: SessionId, ops: TranscriptOp[]): void {
    if (ops.length === 0) { return; }
    const records = opsPayloads(id, 0, ops);
    const first = this.deps.state.nextRevs(id, records.length);
    records.forEach((r, i) => { this.deps.state.enqueue({ ...r, rev: first + i }); });
  }

  private async meta(id: SessionId): Promise<void> {
    const state = this.shareable(id);
    if (!state?.projectId) { return; }
    const branch = await this.deps.branch(state.cwd).catch(() => undefined);
    const payload = {
      type: 'session-meta' as const, v: 1 as const, sessionId: id, projectId: state.projectId,
      relCwd: await this.deps.relCwd(state.cwd), ...(branch ? { branch } : {}), state: publishedState(state),
    };
    const fingerprint = JSON.stringify(payload);
    if (this.deps.state.metaFingerprint(id) === fingerprint) { return; }
    this.deps.state.enqueue(payload);
    this.deps.state.setMetaFingerprint(id, fingerprint);
  }

  private removed(id: SessionId): void {
    if (!this.deps.state.wasSessionPublished(id)) { return; }
    this.deps.state.enqueue({ type: 'session-delete', v: 1, sessionId: id });
    this.deps.state.forgetSession(id);
  }
}
