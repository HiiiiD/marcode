import { AgentSession, type SessionSink } from './agent-session';
import { catalogKey, CatalogService } from './catalog-service';
import type { StoredIndex, TranscriptStore } from './transcript-store';
import type { AgentProvider, EffortLevel, Invocable, ModelInfo, UsageWindow } from '../providers/types';
import { findModel, resolveEffort } from '../shared/model-catalog';
import { orderWindows } from '../shared/usage-windows';
import type {
  ContextResult, HostToWebview, McpServerStatus, PaneLayout, PermissionMode, ProviderInfo, SessionId,
  SessionState, SessionStatus, SessionSummary, TranscriptPatch, UnavailableProvider,
} from '../protocol/messages';

let counter = 0;
function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

/**
 * Rejects with `reason` if `work` has not settled within `ms`. The timer is
 * cleared either way: a pending `setTimeout` would otherwise keep the
 * extension host's event loop alive past dispose.
 */
function withTimeout<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), ms);
  });
  return Promise.race([work, bound]).finally(() => {
    if (timer) { clearTimeout(timer); }
  }) as Promise<T>;
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
  /**
   * providerId -> windowId -> the last window that provider reported.
   *
   * Account state, not session state: it is keyed by provider, it outlives
   * every session, and it deliberately does not live on `SessionState` —
   * a restored session must not carry a percentage that has since moved.
   */
  private usage = new Map<string, Map<string, UsageWindow>>();
  /**
   * providerId -> why its last model probe failed.
   *
   * Not persisted: availability is a fact about this machine right now, and a
   * reason restored from disk would outlive the install it described. An
   * entry is written by a failed probe and deleted by a successful one, so it
   * never states anything the last refresh did not.
   */
  private probeFailures = new Map<string, string>();
  /**
   * providerId -> the model list its last successful probe returned, restored
   * from disk at `init()`.
   *
   * Unlike `probeFailures` this IS persisted, and the asymmetry is the point.
   * A restored *failure* would assert something about an install nobody has
   * checked this launch. A restored *model list* asserts only what the
   * backend last said, and it buys the thing a cold panel otherwise cannot
   * have: a working model switcher during the second before the probe lands,
   * instead of every restored pane coming up read-only because `catalog()`
   * is still empty.
   *
   * Consulted only while a provider's own `listModels()` is empty, and
   * dropped by `refreshModels` as soon as that probe answers either way — so
   * it never outlives the first real answer of the session.
   */
  private seededModels = new Map<string, ModelInfo[]>();
  private readonly catalogSvc = new CatalogService(
    (key, entries) => { this.fanOutCatalog(key, entries); },
  );

  constructor(
    private readonly store: TranscriptStore,
    private readonly providers: Map<string, AgentProvider>,
    private readonly emit: (msg: HostToWebview) => void,
    /**
     * How long a provider gets to answer `contextBreakdown()` before the
     * popover is told the answer is unavailable. The SDK call is a control
     * request to a subprocess that can simply never reply; without a bound,
     * the webview sits in its loading state for the life of the panel.
     */
    private readonly contextTimeoutMs = 5000,
  ) {}

  async init(): Promise<void> {
    const index = await this.store.readIndex();
    for (const state of index.sessions) {
      this.meta.set(state.id, {
        ...state,
        status: 'idle',
        includeEditorContext: state.includeEditorContext ?? true,
      });
    }
    this.paneLayout = index.layout;

    const usage = await this.store.readUsage();
    for (const [providerId, windows] of Object.entries(usage.providers)) {
      this.usage.set(providerId, new Map(windows.map((w) => [w.id, w])));
    }

    // A seed for a provider this build no longer configures is harmless and
    // needs no filtering here: every reader — `modelsFor`, and through it
    // `catalog()` and `catalogSnapshot()` — iterates `this.providers`, so an
    // orphan is never read and never rewritten.
    const catalog = await this.store.readCatalog();
    for (const [providerId, models] of Object.entries(catalog.providers)) {
      this.seededModels.set(providerId, models);
    }
  }

  /**
   * The providers that can actually be picked — those with at least one
   * model. A provider's model list is its availability: it comes from the
   * backend, so an empty one means the backend never answered (or answered
   * that this install can run nothing), and offering it would be offering
   * something the host cannot honor. See `unavailable()` for the other half.
   */
  catalog(): ProviderInfo[] {
    return [...this.providers.values()]
      .map((p) => ({ id: p.id, displayName: p.displayName, models: this.modelsFor(p) }))
      .filter((p) => p.models.length > 0);
  }

  /**
   * What this provider can offer right now: its own list when it has one,
   * otherwise the seed restored from disk.
   *
   * The order is not interchangeable. A live list is what the backend said
   * this launch; a seed is what it said last launch. The moment the former
   * exists the latter is not a fallback but a contradiction — and
   * `refreshModels` has already deleted it by then, so this only ever reads a
   * seed no probe has answered for yet.
   */
  private modelsFor(p: AgentProvider): ModelInfo[] {
    const live = p.listModels();
    return live.length > 0 ? live : this.seededModels.get(p.id) ?? [];
  }

  /** Every provider's usable model list, for `catalog.json`. */
  private catalogSnapshot(): Record<string, ModelInfo[]> {
    const out: Record<string, ModelInfo[]> = {};
    for (const p of this.providers.values()) {
      const models = this.modelsFor(p);
      if (models.length > 0) { out[p.id] = models; }
    }
    return out;
  }

  /**
   * The configured providers `catalog()` leaves out, each with the reason its
   * last probe gave. A provider that has simply not been probed yet is absent
   * from both — "not yet asked" is not a diagnosis.
   */
  unavailable(): UnavailableProvider[] {
    return [...this.providers.values()]
      .filter((p) => this.modelsFor(p).length === 0 && this.probeFailures.has(p.id))
      .map((p) => ({
        id: p.id, displayName: p.displayName, reason: this.probeFailures.get(p.id)!,
      }));
  }

  /**
   * Asks every provider that can answer for its real model catalog, then
   * re-announces `catalog()` once. Fire-and-forget by design, like the
   * invocables probe: models are picker content, and nothing — session
   * creation least of all — may wait on a CLI handshake for them.
   *
   * This is also the availability probe. A provider that cannot answer has no
   * models, so it leaves the catalog and is announced as unavailable with the
   * reason it gave; one that starts answering rejoins. Calling this again is
   * therefore the whole mechanism for re-checking an install — which is what
   * a future "path to the executable" setting would do on change.
   *
   * One emit after all probes settle, not one per provider: the wire message
   * carries the whole catalog, so per-provider emits would just be N
   * successive whole-catalog replacements.
   */
  async refreshModels(cwd: string): Promise<void> {
    const probes = [...this.providers.values()]
      .filter((p) => p.fetchModels)
      // Wrapped in Promise.resolve().then(...) rather than calling
      // fetchModels(cwd) directly: the interface only promises a Promise
      // return, not an async function, so a provider that throws
      // synchronously (legal against the type) would otherwise throw here
      // in refreshModels' own synchronous body instead of rejecting the
      // per-provider promise this .catch is attached to.
      .map((p) => Promise.resolve().then(() => p.fetchModels!(cwd)).then(
        // Success clears any recorded failure: a reason that outlives the
        // failure it describes is a lie about the install.
        // Success clears the seed as well: the provider now has a live list,
        // and keeping a stand-in for an answer that has arrived is how a
        // cache starts disagreeing with the thing it caches.
        () => { this.probeFailures.delete(p.id); this.seededModels.delete(p.id); },
        (err: unknown) => {
          // Errors are state, never exceptions — and the state here is "this
          // provider cannot be picked, and here is why". Still worth a
          // developer-facing trace: the panel shows one line, not a stack.
          console.warn('[hiiiid-code] session-manager: model probe failed for', p.id, err);
          this.probeFailures.set(p.id, err instanceof Error ? err.message : String(err));
          // Drop the seed for the same reason a stale `probeFailures` entry is
          // dropped on success: the probe has now answered, and a model list
          // that outlives the install it came from is a lie the picker would
          // otherwise keep telling. The provider falls to `unavailable()` with
          // the real reason.
          this.seededModels.delete(p.id);
        },
      ));
    if (probes.length === 0) { return; }

    await Promise.all(probes);
    if (this.disposed) { return; }
    this.emit({ t: 'catalog', catalog: this.catalog(), unavailable: this.unavailable() });
    // Record what the backend just said, so the next launch's panel comes up
    // with a live model switcher instead of waiting on this same probe.
    this.schedulePersist();
  }

  /**
   * Asks every provider that can answer for its account's plan usage, with
   * no session required. Fire-and-forget by design, exactly like
   * refreshModels: this is what puts real percentages in the strip at
   * activation, and nothing — least of all panel startup — may wait on a CLI
   * handshake for decoration.
   *
   * One emit per provider rather than one at the end, unlike refreshModels:
   * the wire message is per-provider, so there is no whole-set message to
   * batch into, and a fast provider should not wait behind a slow one.
   */
  async refreshUsage(cwd: string): Promise<void> {
    await Promise.all([...this.providers.values()]
      .filter((p) => p.fetchUsage)
      // Wrapped in Promise.resolve().then(...) rather than calling
      // fetchUsage(cwd) directly: the interface only promises a Promise
      // return, not an async function, so a provider that throws
      // synchronously (legal against the type) would otherwise throw here in
      // refreshUsage's own synchronous body — rejecting refreshUsage() itself
      // (fire-and-forget from the router, so an unhandled rejection) and
      // skipping every provider queued after it, instead of being caught by
      // the .then rejection handler below.
      .map((p) => Promise.resolve().then(() => p.fetchUsage!(cwd)).then(
        (windows) => { if (!this.disposed) { this.usageWindows(p.id, windows); } },
        (err: unknown) => {
          // Errors are state, never exceptions — and the state here is
          // "whatever the last pull or the persisted file said still
          // stands". Worth a developer-facing trace: a permanently broken
          // CLI would otherwise be indistinguishable from an account that
          // genuinely has no plan limits.
          console.warn('[hiiiid-code] session-manager: usage probe failed for', p.id, err);
        },
      )));
  }

  summaries(): SessionSummary[] {
    return [...this.meta.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  layout(): PaneLayout { return this.paneLayout; }

  private keyOf(state: SessionState): string {
    return catalogKey(state.providerId, state.cwd);
  }

  /**
   * Pushes a catalog to every session on this key — live or not — and emits
   * it to the visible ones. Meta, not `live`, is the roster: a session that
   * is not materialized still needs its snapshot to carry the catalog when
   * it is next revealed.
   *
   * Skips the direct emit while a session's snapshot fetch is in flight
   * (`snapshotting.has(id)`) — the same ordering hazard `patch()` guards
   * against. `visible` is set synchronously at the top of `setVisible()`,
   * before its `await session.snapshot()`; emitting here during that window
   * would land `session-invocables` before the `session-snapshot` it
   * belongs to. `setInvocables` still runs unconditionally, so the pending
   * snapshot carries the fresh value, and `setVisible`'s live-branch
   * catch-up re-announces it in a standalone message once the snapshot has
   * landed — see there.
   */
  private fanOutCatalog(key: string, entries: Invocable[]): void {
    for (const state of this.meta.values()) {
      if (this.keyOf(state) !== key) { continue; }
      this.live.get(state.id)?.setInvocables(entries);
      if (this.visible.has(state.id) && !this.snapshotting.has(state.id)) {
        this.emit({ t: 'session-invocables', id: state.id, entries });
      }
    }
  }

  setLayout(layout: PaneLayout): void {
    this.paneLayout = layout;
    this.schedulePersist();
  }

  async create(
    providerId: string, cwd: string, model?: string, effort?: EffortLevel,
    mode: PermissionMode = 'default',
  ): Promise<AgentSession> {
    const provider = this.providers.get(providerId);
    if (!provider) { throw new Error(`Unknown provider: ${providerId}`); }

    // The seed counts here, deliberately: this reads the same list `catalog()`
    // published, so a provider the panel showed as pickable is pickable. The
    // alternative — offer it, then refuse it — is a worse failure than the one
    // this admits, which is a session created against an install whose probe
    // has not answered yet. That one surfaces as a session in `error` with a
    // transcript item, which is how every other provider failure surfaces.
    const models = this.modelsFor(provider);
    // Availability, checked at the one point where it matters. The webview
    // already hides an unavailable provider, so reaching here means a stale
    // catalog or a message we did not send ourselves — either way, creating
    // the session would only produce one that cannot run.
    if (models.length === 0) {
      throw new Error(
        `Provider unavailable: ${providerId}`
        + (this.probeFailures.has(providerId) ? ` (${this.probeFailures.get(providerId)!})` : ''),
      );
    }
    const chosen = findModel(models, model) ?? models[0];
    const resolvedEffort = resolveEffort(chosen, effort);

    const now = Date.now();
    const state: SessionState = {
      id: newSessionId(), providerId, model: chosen.id, effort: resolvedEffort,
      title: 'Untitled', cwd, status: 'idle', permissionMode: mode,
      includeEditorContext: true,
      usage: { inputTokens: 0, outputTokens: 0 },
      archived: false, createdAt: now, updatedAt: now,
    };

    const session = new AgentSession(state, provider, this.store, this);
    this.meta.set(state.id, state);
    this.live.set(state.id, session);
    const cached = this.catalogSvc.get(this.keyOf(state));
    if (cached) { session.setInvocables(cached); }
    this.catalogSvc.ensure(this.keyOf(state), provider, state.cwd);
    this.changed();
    return session;
  }

  get(id: SessionId): AgentSession | undefined { return this.live.get(id); }

  /**
   * Never rejects: this is answered straight onto the wire, where "errors
   * are state". An archived or never-opened session has no live run to ask,
   * which is a legitimate not-ok rather than a failure.
   */
  async contextBreakdown(id: SessionId): Promise<ContextResult> {
    // What the last turn recorded, which for a session with no live query
    // behind it *is* the current context: the conversation cannot have
    // changed without a send, and a send builds the query.
    const remembered = this.meta.get(id)?.lastContext;
    const session = this.live.get(id);
    if (!session) {
      if (remembered) { return { ok: true, breakdown: remembered }; }
      return { ok: false, reason: 'This session is not running' };
    }
    try {
      return { ok: true, breakdown: await withTimeout(
        session.contextBreakdown(),
        this.contextTimeoutMs,
        'The provider did not report context usage in time',
      ) };
    } catch (err) {
      // The common failure here is a Claude session restored across a
      // reload: its run is constructed lazily on the first send, so there
      // is no query to measure yet even though the conversation is intact.
      if (remembered) { return { ok: true, breakdown: remembered }; }
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Every provider's current window set, ordered for display and with
   * already-reset windows dropped. The pruning happens on read rather than
   * on a timer: nothing re-renders between reads anyway, and a timer would
   * be a second clock to keep correct.
   */
  usageSnapshot(): Record<string, UsageWindow[]> {
    const out: Record<string, UsageWindow[]> = {};
    for (const providerId of this.usage.keys()) {
      out[providerId] = this.windowsFor(providerId);
    }
    return out;
  }

  private windowsFor(providerId: string): UsageWindow[] {
    const known = this.usage.get(providerId);
    if (!known) { return []; }
    const now = Date.now();
    // A window whose reset has passed is known to be wrong, and the next
    // event may be hours away — so it is dropped, not shown at its last
    // percentage. This is the one case where "last known" is not the truth.
    return orderWindows(
      [...known.values()].filter((w) => w.resetsAt === undefined || w.resetsAt > now),
    );
  }

  /**
   * Whether `path` is one the session itself reported as a loaded memory
   * file. `open-file` arrives over `postMessage` carrying a path that
   * originated in provider-reported data; without this the host would open
   * any file on disk a buggy or compromised provider named. A session with
   * no live run — or one that has never answered a breakdown — vouches for
   * nothing, so nothing opens.
   */
  /**
   * Also honours the persisted breakdown, not just the live session's: a
   * resumed session answers `request-context` from `lastContext`, and every
   * memory file in that answer renders as a link. Vouching only for what a
   * live run reported would leave each of those links inert.
   */
  canOpenFile(id: SessionId, path: string): boolean {
    if (this.live.get(id)?.reportedMemoryFile(path)) { return true; }
    return this.meta.get(id)?.lastContext?.memoryFiles.some((f) => f.path === path) ?? false;
  }

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
    const cached = this.catalogSvc.get(this.keyOf(state));
    if (cached) { session.setInvocables(cached); }
    this.catalogSvc.ensure(this.keyOf(state), provider, state.cwd);
    this.changed();
    return session;
  }

  async setVisible(ids: SessionId[]): Promise<void> {
    const next = new Set(ids);
    const added = ids.filter((id) => !this.visible.has(id));
    // Captured before `visible` is replaced: hiding a pane is the *other*
    // way an unused session stops being shown (the pane header's X and the
    // roster checkbox both post set-layout/set-visible, never close-session),
    // and without this the roster accumulates 'Untitled' rows that only the
    // row's overflow menu can ever remove. Same discard rule as close().
    const removed = [...this.visible].filter((id) => !next.has(id));
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
        // Every reveal with a known catalog re-announces it in a standalone
        // message — whether that catalog was cached long ago or only just
        // landed (fanOutCatalog withholds its emit for the whole time this
        // session's snapshot is in flight; see its doc comment). Either way
        // the webview needs no special case for a pane revealed before its
        // probe resolved: it always gets a `session-invocables` right after
        // the `session-snapshot` that already carries the same value inline.
        const cachedEntries = this.catalogSvc.get(this.keyOf(session.state));
        if (cachedEntries) {
          this.emit({ t: 'session-invocables', id, entries: cachedEntries });
        }
        this.drainSnapshotBuffer(id);
        continue;
      }
      const state = this.meta.get(id);
      if (!state) {
        if (this.snapshotSeq.get(id) === seq) { this.snapshotting.delete(id); }
        continue;
      }
      const provider = this.providers.get(state.providerId);
      if (provider) { this.catalogSvc.ensure(this.keyOf(state), provider, state.cwd); }
      const { items, hasMore } = await this.store.tail(id);
      if (!this.claimSnapshot(id, seq)) { continue; }
      this.emit({
        t: 'session-snapshot',
        session: {
          ...state, items, hasMore, pending: [],
          invocables: this.catalogSvc.get(this.keyOf(state)),
          // An archived session has no run to ask, and a stale snapshot
          // presented as current would be a lie.
          mcpServers: [],
        },
      });
      this.drainSnapshotBuffer(id);
    }

    // After the reveals, not before: `remove()` fans out a roster change,
    // and a hidden-and-discarded session must not race the snapshot the
    // newly revealed one is waiting on.
    for (const id of removed) {
      // A session with a snapshot still in flight is mid-reveal, not
      // abandoned — an uncheck/re-check in the roster passes through here
      // while the first fetch is outstanding. Leave it alone rather than
      // reading a transcript the in-flight fetch is already reading.
      if (this.snapshotting.has(id)) { continue; }
      const state = this.meta.get(id);
      if (state && await this.isDiscardable(id, state)) { await this.remove(id); }
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

  /**
   * Closing a session that was never used discards it outright instead of
   * archiving it: an untitled session with an empty transcript carries
   * nothing to come back to, and archiving it would leave the roster
   * accumulating placeholder rows that can only ever be deleted by hand.
   *
   * "Never used" is title *and* transcript, not either alone. The title is
   * only stamped by the first `send()`, so `'Untitled'` alone would also
   * match a session whose sole item is a startup error — worth keeping, it
   * is the only record of why the session failed. Conversely the transcript
   * alone would be empty for a live-revived session whose items are all on
   * disk, hence the store read on the non-live path.
   */
  private async isDiscardable(id: SessionId, state: SessionState): Promise<boolean> {
    if (state.title !== 'Untitled') { return false; }
    const session = this.live.get(id);
    if (session && !session.isEmpty) { return false; }
    const { items, hasMore } = await this.store.tail(id, 1);
    return !hasMore && items.length === 0;
  }

  async close(id: SessionId): Promise<void> {
    const state = this.meta.get(id);
    if (state && await this.isDiscardable(id, state)) {
      await this.remove(id);
      return;
    }
    await this.archive(id);
  }

  private async archive(id: SessionId): Promise<void> {
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
    await this.archive(id);
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

  invocables(id: SessionId, entries: Invocable[]): void {
    const state = this.meta.get(id);
    if (!state) { return; }
    // Cache under the cwd key and fan out. The reporting session gets the
    // entries back through the same fan-out as its siblings, so there is one
    // path, not two.
    this.catalogSvc.set(this.keyOf(state), entries);
  }

  usageWindows(providerId: string, windows: UsageWindow[] | undefined): void {
    // A pull is a snapshot, so it REPLACES the provider's map rather than
    // upserting into it — that is what lets a window the account stopped
    // reporting actually disappear. (The old push carried one window at a
    // time and had to upsert; this does not.)
    // Ordered before comparing, not just before storing: `prev` comes from
    // `windowsFor()`, which is already ordered, so an unordered `next` would
    // make the positional comparison below spurious for a provider that
    // simply reports the same set in a different order — a false "changed"
    // from index misalignment alone, not from any window actually moving.
    const next = windows === undefined ? [] : orderWindows(windows);
    const prev = this.windowsFor(providerId);
    const same = prev.length === next.length && prev.every((w, i) =>
      w.id === next[i]?.id
      && w.usedPercent === next[i]?.usedPercent
      && w.resetsAt === next[i]?.resetsAt);
    if (same && (windows !== undefined || !this.usage.has(providerId))) { return; }

    if (windows === undefined) {
      // A positive "this account has no plan limits". Drop the provider so a
      // subscription-to-API-key switch cannot keep showing stale numbers.
      this.usage.delete(providerId);
    } else {
      this.usage.set(providerId, new Map(next.map((w) => [w.id, w])));
    }
    this.emit({ t: 'usage-windows', providerId, windows: this.windowsFor(providerId) });
    this.schedulePersist();
  }

  mcp(id: SessionId, servers: McpServerStatus[]): void {
    // Gated on visibility for the same reason patch() is: a background
    // session's server list is rendered nowhere. Unlike invocables, this is
    // per-session live state rather than a cwd-keyed catalog, so there is
    // nothing to cache and no fan-out to siblings.
    if (!this.visible.has(id)) { return; }
    this.emit({ t: 'session-mcp', id, servers });
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
    // usageSnapshot() prunes reset windows on the way out, so a file written
    // now cannot resurrect one on the next load.
    await this.store.writeUsage({ providers: this.usageSnapshot() });
    await this.store.writeCatalog({ providers: this.catalogSnapshot() });
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
