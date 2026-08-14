import { AgentSession, type SessionSink } from './agent-session';
import type { StoredIndex, TranscriptStore } from './transcript-store';
import type { AgentProvider, EffortLevel } from '../providers/types';
import type {
  HostToWebview, PaneLayout, ProviderInfo, SessionId, SessionState,
  SessionStatus, SessionSummary, TranscriptPatch,
} from '../protocol/messages';

let counter = 0;
function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

export class SessionManager implements SessionSink {
  private live = new Map<SessionId, AgentSession>();
  private meta = new Map<SessionId, SessionState>();
  private visible = new Set<SessionId>();
  private paneLayout: PaneLayout = { orientation: 'vertical', panes: [] };
  private persistTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  /**
   * setVisible() reveals a session by fetching its snapshot (an await), then
   * emitting `session-snapshot`. A patch for that same id can arrive from
   * the live AgentSession while that snapshot fetch is in flight — patch()
   * only gates on `visible`, so once we've added the id to `visible` (which
   * we must do promptly so status/changed keep flowing) that patch is
   * emitted immediately, potentially landing before the snapshot it should
   * follow and getting silently clobbered when the (now stale) snapshot
   * arrives after it. Buffer patches per id while its snapshot fetch is in
   * flight and replay them, in order, right after that snapshot is emitted.
   *
   * setVisible() is also re-entrant: unchecking then re-checking a session in
   * the roster picker starts a second fetch for the same id while the first
   * is still in flight, and the second `snapshotting.set(id, [])` replaces
   * the first's buffer. Whichever fetch resolves first would then drain the
   * *other's* patches and delete the entry, and the loser's now-stale
   * snapshot would be emitted afterwards, wholesale replacing the pane and
   * discarding exactly the patches this buffer exists to protect. So each
   * invocation stamps a sequence number; on resume, an invocation that is no
   * longer the newest for that id (or whose id has since left `visible`)
   * drops its snapshot and touches nothing.
   *
   * The counter is global and strictly monotonic, never per-id and never
   * reset. A per-id counter that restarted whenever its entry was deleted
   * would make sequence numbers reusable: with fetch #1 (seq 1) still in
   * flight, a reveal that drains at seq 2 and a third uncheck/recheck would
   * reissue seq 1, and fetch #1 would then claim the snapshot it no longer
   * owns — the exact clobber this sequencing exists to prevent, via ABA.
   */
  private snapshotting = new Map<SessionId, TranscriptPatch[]>();
  private snapshotSeq = new Map<SessionId, number>();
  private nextSnapshotSeq = 0;

  constructor(
    private readonly store: TranscriptStore,
    private readonly providers: Map<string, AgentProvider>,
    private readonly emit: (msg: HostToWebview) => void,
  ) {}

  async init(): Promise<void> {
    const index = await this.store.readIndex();
    for (const state of index.sessions) {
      this.meta.set(state.id, { ...state, status: 'idle' });
    }
    this.paneLayout = index.layout;
  }

  catalog(): ProviderInfo[] {
    return [...this.providers.values()].map((p) => ({
      id: p.id, displayName: p.displayName, models: p.listModels(),
    }));
  }

  summaries(): SessionSummary[] {
    return [...this.meta.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  layout(): PaneLayout { return this.paneLayout; }

  setLayout(layout: PaneLayout): void {
    this.paneLayout = layout;
    this.schedulePersist();
  }

  async create(
    providerId: string, cwd: string, model?: string, effort?: EffortLevel,
  ): Promise<AgentSession> {
    const provider = this.providers.get(providerId);
    if (!provider) { throw new Error(`Unknown provider: ${providerId}`); }

    const models = provider.listModels();
    const chosen = models.find((m) => m.id === model) ?? models[0];
    const resolvedEffort = chosen.effort
      ? (effort && chosen.effort.levels.includes(effort) ? effort : chosen.effort.default)
      : undefined;

    const now = Date.now();
    const state: SessionState = {
      id: newSessionId(), providerId, model: chosen.id, effort: resolvedEffort,
      title: 'Untitled', cwd, status: 'idle', permissionMode: 'default',
      usage: { inputTokens: 0, outputTokens: 0 },
      archived: false, createdAt: now, updatedAt: now,
    };

    const session = new AgentSession(state, provider, this.store, this);
    this.meta.set(state.id, state);
    this.live.set(state.id, session);
    this.changed();
    return session;
  }

  get(id: SessionId): AgentSession | undefined { return this.live.get(id); }

  async open(id: SessionId): Promise<AgentSession> {
    const existing = this.live.get(id);
    if (existing) { return existing; }

    const state = this.meta.get(id);
    if (!state) { throw new Error(`Unknown session: ${id}`); }
    const provider = this.providers.get(state.providerId);
    if (!provider) { throw new Error(`Unknown provider: ${state.providerId}`); }

    state.archived = false;
    state.status = 'idle';
    const session = new AgentSession(state, provider, this.store, this);
    this.live.set(id, session);
    this.changed();
    return session;
  }

  async setVisible(ids: SessionId[]): Promise<void> {
    const next = new Set(ids);
    const added = ids.filter((id) => !this.visible.has(id));
    this.visible = next;

    for (const id of added) {
      // Mark this id as "snapshot in flight" so patch() buffers instead of
      // emitting for it — see the `snapshotting` field doc comment.
      const seq = ++this.nextSnapshotSeq;
      this.snapshotSeq.set(id, seq);
      this.snapshotting.set(id, []);

      const session = this.live.get(id);
      if (session) {
        const snapshot = await session.snapshot();
        if (!this.claimSnapshot(id, seq)) { continue; }
        this.emit({ t: 'session-snapshot', session: snapshot });
        this.drainSnapshotBuffer(id);
        continue;
      }
      const state = this.meta.get(id);
      if (!state) {
        if (this.snapshotSeq.get(id) === seq) { this.snapshotting.delete(id); }
        continue;
      }
      const { items, hasMore } = await this.store.tail(id);
      if (!this.claimSnapshot(id, seq)) { continue; }
      this.emit({
        t: 'session-snapshot',
        session: { ...state, items, hasMore, pending: [], mcpServers: [] },
      });
      this.drainSnapshotBuffer(id);
    }
  }

  /**
   * True when this invocation is still the one entitled to emit a snapshot
   * for `id`. A superseded invocation must leave the buffer alone — it
   * belongs to the newer fetch, whose snapshot is strictly fresher. An id
   * that left `visible` mid-flight has no pane to fill, so its buffer is
   * dropped instead.
   */
  private claimSnapshot(id: SessionId, seq: number): boolean {
    if (this.snapshotSeq.get(id) !== seq) { return false; }
    if (!this.visible.has(id)) {
      this.snapshotting.delete(id);
      this.snapshotSeq.delete(id);
      return false;
    }
    return true;
  }

  /** Emits any patches that arrived for `id` while its snapshot was in flight. */
  private drainSnapshotBuffer(id: SessionId): void {
    const buffered = this.snapshotting.get(id);
    this.snapshotting.delete(id);
    this.snapshotSeq.delete(id);
    if (!buffered) { return; }
    for (const patch of buffered) {
      this.emit({ t: 'session-patch', id, patch });
    }
  }

  async close(id: SessionId): Promise<void> {
    const session = this.live.get(id);
    if (session) {
      await session.dispose();
      this.live.delete(id);
    }
    const state = this.meta.get(id);
    if (state) {
      state.archived = true;
      state.status = 'idle';
      state.updatedAt = Date.now();
    }
    this.visible.delete(id);
    this.changed();
  }

  async remove(id: SessionId): Promise<void> {
    await this.close(id);
    this.meta.delete(id);
    await this.store.remove(id);
    this.paneLayout = {
      ...this.paneLayout,
      panes: this.paneLayout.panes.filter((p) => p.sessionId !== id),
    };
    this.changed();
  }

  async dispose(): Promise<void> {
    // AgentSession.dispose() drains in-flight events (denying outstanding
    // permissions, waiting out its event pump) before it resolves; any
    // event arriving during that drain calls sink.changed() ->
    // schedulePersist(), which would arm a new timer. Clearing the timer
    // and marking disposed BEFORE the session disposals lets that race
    // reintroduce a live timer that fires after dispose() has returned and
    // the caller has already torn down rootDir. Mark disposed (so
    // schedulePersist() becomes a no-op) and only clear the timer AFTER
    // every session has actually finished disposing.
    this.disposed = true;
    await Promise.all([...this.live.values()].map((s) => s.dispose()));
    this.live.clear();
    if (this.persistTimer) { clearTimeout(this.persistTimer); }
    await this.persist();
  }

  // --- SessionSink ---

  patch(id: SessionId, patch: TranscriptPatch): void {
    if (!this.visible.has(id)) { return; }
    const buffer = this.snapshotting.get(id);
    if (buffer) { buffer.push(patch); return; }
    this.emit({ t: 'session-patch', id, patch });
  }

  status(id: SessionId, status: SessionStatus): void {
    this.emit({ t: 'session-status', id, status });
  }

  changed(): void {
    this.emit({ t: 'sessions-changed', sessions: this.summaries() });
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.disposed) { return; }
    if (this.persistTimer) { clearTimeout(this.persistTimer); }
    // persist() awaits real fs calls (writeIndex/flush) that can reject
    // (EPERM/EBUSY are routine on Windows) with nothing here to catch them
    // — never let that become an unhandled rejection.
    this.persistTimer = setTimeout(() => { this.persist().catch(() => { /* see above */ }); }, 500);
  }

  private async persist(): Promise<void> {
    const index: StoredIndex = {
      sessions: [...this.meta.values()],
      layout: this.paneLayout,
    };
    await this.store.writeIndex(index);
    // Deviation from the brief: TranscriptStore.flush() previously was not
    // safe to call concurrently for the same session id from two different
    // call sites. AgentSession serializes *its own* flush() calls through an
    // internal chained promise, but that chain has no visibility into calls
    // made by anyone else sharing the same TranscriptStore instance. This
    // manager's periodic persist() timer calls store.flush() with no id
    // (flushing every session with pending/dirty writes), which can fire
    // while a live AgentSession's own scheduleFlush() (e.g. on turn-end) is
    // mid-flight for the same id. TranscriptStore.flush()'s non-dirty path
    // reads the pending queue, appends it to disk, and only then clears it;
    // two overlapping calls can both read the same queue before either
    // clears it and each append it, duplicating every item in that window
    // on disk. Fixed at the source in TranscriptStore (flush() now
    // serializes per session id internally — see transcript-store.ts), so
    // this call is safe regardless of what else is flushing concurrently.
    await this.store.flush();
  }
}
