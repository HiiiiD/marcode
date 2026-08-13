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
      const session = this.live.get(id);
      if (session) {
        this.emit({ t: 'session-snapshot', session: await session.snapshot() });
        continue;
      }
      const state = this.meta.get(id);
      if (!state) { continue; }
      const { items, hasMore } = await this.store.tail(id);
      this.emit({
        t: 'session-snapshot',
        session: { ...state, items, hasMore, pending: [] },
      });
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
    if (this.persistTimer) { clearTimeout(this.persistTimer); }
    await Promise.all([...this.live.values()].map((s) => s.dispose()));
    this.live.clear();
    await this.persist();
  }

  // --- SessionSink ---

  patch(id: SessionId, patch: TranscriptPatch): void {
    if (!this.visible.has(id)) { return; }
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
    if (this.persistTimer) { clearTimeout(this.persistTimer); }
    this.persistTimer = setTimeout(() => { void this.persist(); }, 500);
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
