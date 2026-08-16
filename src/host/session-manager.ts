import { resolve } from 'node:path';
import { AgentSession, type SessionSink } from './agent-session';
import { catalogKey, CatalogService } from './catalog-service';
import { claimedPaths, toRepoRelative } from './claim-paths';
import { treeChanges } from './fleet-diff';
import { bringBack as runBringBack, bringBackPlan, samePath, treeStatus } from './git-worktree';
import { buildSeed } from './replay';
import { findPayload, type ResolvedBlock } from './session-refs';
import { TRANSCRIPT_VERSION, type StoredIndex, type TranscriptStore } from './transcript-store';
import type { AgentProvider, EffortLevel, Invocable, ModelInfo, UsageWindow } from '../providers/types';
import { findModel, resolveEffort } from '../shared/model-catalog';
import { resolvePermissionMode } from '../shared/permission-catalog';
import { threadKey, threadKeyCwd } from '../shared/thread-key';
import { orderWindows } from '../shared/usage-windows';
import type {
  ContextResult, HostToWebview, McpServerStatus, PaneLayout, PermissionMode, ProviderInfo, SessionId,
  SessionRef, SessionSnapshot, SessionState, SessionStatus, SessionSummary, StaleTree,
  TranscriptItem, TranscriptPatch, TreeDiff, UnavailableProvider,
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
  /**
   * Claims rebuilt from a session's transcript, once per session per launch.
   *
   * A live `AgentSession` only knows what it wrote since it was constructed —
   * a session restored from `index.json`, or one rebuilt by `moveTo`, starts
   * empty. This is the pre-launch half, read from the JSONL the first time
   * anything asks. Cached in memory and never persisted: see
   * `AgentSession.claimedPaths` for why a stored claim would be a lie.
   */
  private readonly backfilled = new Map<SessionId, Set<string>>();
  private paneLayout: PaneLayout = { orientation: 'vertical', panes: [] };
  private persistTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  /**
   * Relocation offers answered with Move while a turn was in flight, keyed by
   * session — the item id to perform once that session next reaches `idle`.
   *
   * Deliberately in memory only, and deliberately at most one per session. The
   * offer is raised from a `tool-end` mid-turn, so "running" is the common
   * case, not the exception; dropping the click there is how the feature used
   * to fail silently.
   *
   * The item it points at is marked `queued`, because the host owns the state
   * and the webview renders it: a deferral nobody can see is a card left
   * asking a question under two dead buttons for the length of a turn. That
   * this map does not survive a reload is not a reason to hide it — it is a
   * reason to reconcile it, which `emitSnapshot` does the next time the
   * transcript is handed to a pane.
   */
  private queuedMoves = new Map<SessionId, string>();
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
    /**
     * A session's shell reported a PowerShell profile that fails to load under
     * Codex's `pwsh -Command` wrapper. Injected because the advice is a VS Code
     * notification and this class imports no `vscode`; the default no-op keeps
     * every existing construction site valid.
     */
    private readonly onShellNoise: (profile: string) => void = () => {},
  ) {}

  async init(): Promise<void> {
    const index = await this.store.readIndex();
    for (const state of index.sessions) {
      this.meta.set(state.id, {
        ...state,
        status: 'idle',
        // Dropped for the same reason `status` is reset: a parked message
        // waits on a turn this process never started, and the editor context
        // it was typed against lived only in the session that is now gone.
        // Restoring the words without the attachment would send something
        // other than what the user committed to.
        queued: undefined,
        includeEditorContext: state.includeEditorContext ?? true,
        // An index written before this field existed still passes the version
        // guard — `TRANSCRIPT_VERSION` did not move for it — so a restored
        // session can reach `AgentSession` with no map at all, and the keyed
        // read in its constructor would throw on undefined. Empty is also the
        // exact truth: a session with no recorded threads has no tokens.
        resumeTokens: state.resumeTokens ?? {},
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
      .map((p) => ({
        id: p.id,
        displayName: p.displayName,
        models: this.modelsFor(p),
        permissionModes: p.listPermissionModes(),
      }))
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
    // The same gate `resolveEffort` is, for the same reason: a mode is a
    // property of the provider, not of the session. The create dialog can
    // post a mode the picked provider does not declare — pick Claude +
    // Auto-edit, then switch the model radio to a Codex model, and `create`
    // arrives with `acceptEdits`, which Codex has no equivalent for. Without
    // this the session PERSISTS as `acceptEdits`, the composer and roster
    // label it "Auto-edit", and `map-settings.ts` quietly runs it as
    // `default` — the UI claiming one thing while the backend does another.
    const resolvedMode = resolvePermissionMode(provider.listPermissionModes(), mode);

    const now = Date.now();
    const state: SessionState = {
      id: newSessionId(), providerId, model: chosen.id, effort: resolvedEffort,
      title: 'Untitled', cwd, status: 'idle', permissionMode: resolvedMode,
      includeEditorContext: true,
      resumeTokens: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      pendingQuestions: [],
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
   * Answers a pending relocation offer.
   *
   * A move is `archive()` -> `open()` with one field changed, which is why it
   * introduces almost no lifecycle: dispose the run, repoint `cwd`, and
   * rebuild. Whether the new thread resumes or is seeded is decided by
   * `threadKey` — the provider declares whether its tokens travel.
   *
   * Never rejects for a decision that simply cannot be honored: an unknown
   * session and an already-answered item are both no-ops, because this is
   * answered straight off the wire where errors are state.
   *
   * A turn in flight does not refuse the move — it defers it. Declining is
   * unaffected: Stay never touches the provider, so it settles at once.
   */
  async relocate(id: SessionId, itemId: string, move: boolean): Promise<void> {
    const state = this.meta.get(id);
    const session = this.live.get(id);
    if (!state || !session) { return; }

    const item = await this.store.find(id, itemId);
    if (!item || item.role !== 'relocation' || item.state !== 'pending') { return; }

    // A turn in flight finishes on the tree it started in, so the move waits
    // for idle rather than being dropped. The item is marked `queued` BEFORE
    // the entry goes in the map: the replacement is what the webview sees,
    // and a queue entry with no visible counterpart is exactly the silent
    // deferral this branch used to be.
    if (move && state.status !== 'idle') {
      await session.replaceRelocation({ ...item, state: 'queued' });
      this.queuedMoves.set(id, itemId);
      return;
    }

    await this.settleRelocation(id, session, state, item, move);
  }

  /**
   * Calls off a queued move and reopens the offer.
   *
   * Only ever `queued` -> `pending`: an item that already settled is a record
   * of where the work went, and cancel must not rewrite history. Like
   * `relocate`, this is answered straight off the wire, so every miss is a
   * no-op rather than a rejection.
   */
  async cancelRelocation(id: SessionId, itemId: string): Promise<void> {
    const session = this.live.get(id);
    if (!session) { return; }

    const item = await this.store.find(id, itemId);
    if (!item || item.role !== 'relocation' || item.state !== 'queued') { return; }

    // Keyed check, not a blind delete: the map holds at most one entry per
    // session, and cancelling a stale item (one left `queued` by a reload)
    // must not throw away a move the user queued since.
    if (this.queuedMoves.get(id) === itemId) { this.queuedMoves.delete(id); }
    await session.replaceRelocation({ ...item, state: 'pending' });
  }

  /**
   * Writes the outcome and, for a move, performs it. Shared by the immediate
   * answer and by the queued one so there is a single place that decides what
   * an answered offer looks like.
   */
  private async settleRelocation(
    id: SessionId, session: AgentSession, state: SessionState,
    item: Extract<TranscriptItem, { role: 'relocation' }>, move: boolean,
  ): Promise<void> {
    const settled: TranscriptItem = { ...item, state: move ? 'moved' : 'stayed' };
    await session.replaceRelocation(settled);
    if (!move) { return; }

    await this.moveTo(id, session, state, item.path);
  }

  /**
   * The one place a whole transcript is handed to the webview, and therefore
   * the one place a stale `queued` offer has to be caught.
   *
   * `queuedMoves` lives in memory; the transcript lives on disk. A reload
   * leaves items promising a move nothing is left to perform, and a promise
   * the host cannot keep is worse than the question it replaced. Every
   * materialization ends here — `setVisible`'s live branch (`snapshot()`), its
   * archived branch (`store.tail`), and the rebuild `moveTo` emits — so
   * reconciling on the way out covers all of them at once. Hydrate's own
   * `open()` + `snapshot()` needs no separate hook: the webview posts
   * `set-visible` for every restored pane, and `SessionManager.visible` starts
   * empty after a reload, so each of those panes passes through here.
   *
   * Deliberately over the items already read rather than a fresh store scan:
   * a reveal is on the critical path of showing a pane, and a second read of
   * the same transcript to answer a question the first read already answered
   * is a cost paid on every reveal for a case that arises once per reload.
   */
  private emitSnapshot(id: SessionId, snapshot: SessionSnapshot): void {
    const queued = this.queuedMoves.get(id);
    let items = snapshot.items;
    let reopenedAny = false;
    for (const [at, item] of items.entries()) {
      if (item.role !== 'relocation' || item.state !== 'queued') { continue; }
      if (item.id === queued) { continue; }
      const reopened: TranscriptItem = { ...item, state: 'pending' };
      // The store too, not just the copy going out: `load-more` pages
      // straight out of it, and so does the next launch.
      this.store.replace(id, reopened);
      if (items === snapshot.items) { items = [...items]; }
      items[at] = reopened;
      reopenedAny = true;
    }
    this.emit({
      t: 'session-snapshot',
      session: reopenedAny ? { ...snapshot, items } : snapshot,
    });
    // An archived session has no AgentSession to schedule a flush, so the
    // correction is pushed to disk here. Fire-and-forget and swallowed: this
    // is called from a sink-adjacent path, the emit above has already told the
    // pane the truth, and a failed write only means the next reveal
    // reconciles the same item again.
    if (reopenedAny) { void this.store.flush(id).catch(() => {}); }
  }

  /**
   * The move itself: dispose the run, repoint `cwd`, rebuild. Shared by the
   * relocation offer and by bringing a branch back, because there is only one
   * way a session changes directory and two code paths doing it their own way
   * is how the two would drift.
   *
   * `forgetThreadAt` is the directory the session is *leaving* when that
   * directory is about to stop existing. Its resume token is dropped so a
   * future worktree created at the same path cannot resume this conversation
   * — the token is keyed by path, and paths get reused.
   */
  private async moveTo(
    id: SessionId, session: AgentSession, state: SessionState, to: string,
    forgetThreadAt?: string,
  ): Promise<void> {
    const provider = this.providers.get(state.providerId);
    if (!provider) { return; }

    await session.dispose();
    this.live.delete(id);
    state.cwd = to;
    state.updatedAt = Date.now();

    if (forgetThreadAt !== undefined) {
      const stale = threadKey(provider.id, provider.threadScope, forgetThreadAt);
      // Never for a provider whose threads are global: its key does not
      // mention the directory, so `stale` IS the key the session is about to
      // resume from, and dropping it would throw away a live conversation to
      // protect against a path that plays no part in it.
      if (stale !== threadKey(provider.id, provider.threadScope, to)) {
        delete state.resumeTokens[stale];
      }
    }

    // Read after the dispose above, never before: dispose flushes, so this is
    // the first point at which the store holds the whole conversation —
    // including any offer we just settled.
    const key = threadKey(provider.id, provider.threadScope, state.cwd);
    const seed = state.resumeTokens[key]
      ? undefined
      : buildSeed((await this.store.tail(id, 200)).items);

    const moved = new AgentSession(state, provider, this.store, this, seed);
    this.live.set(id, moved);
    const cached = this.catalogSvc.get(this.keyOf(state));
    if (cached) { moved.setInvocables(cached); }
    this.catalogSvc.ensure(this.keyOf(state), provider, state.cwd);
    this.changed();
    if (this.visible.has(id)) {
      this.emitSnapshot(id, await moved.snapshot());
    }
  }

  /**
   * Answers "could this session's branch come home?" without touching
   * anything. Read-only, so it is safe to ask on every pane mount — which is
   * exactly what the panel does, because the entry point may only appear for
   * a session that is actually sitting in a linked worktree.
   */
  async requestBringBack(id: SessionId): Promise<void> {
    const state = this.meta.get(id);
    if (!state) { return; }
    const plan = await bringBackPlan(state.cwd);
    if (this.disposed) { return; }
    this.emit({ t: 'bring-back-plan', id, plan });
  }

  /**
   * Removes the session's worktree and checks its branch out in the main tree,
   * then follows it there. The only genuinely destructive thing in this
   * feature, so its refusals are the feature:
   *
   *  - **The plan is recomputed here**, never taken from the dialog. That
   *    dialog may have been open for minutes; what it displayed is a
   *    description of a past state, not an authorization.
   *  - **Git first, cwd second.** A refused git step leaves the session
   *    exactly where it was, with an `error` item saying why — there is no
   *    window in which `cwd` names a directory that no longer exists.
   *  - The one exception is a checkout that fails *after* the removal
   *    succeeded. The directory is already gone by then, so staying is not
   *    one of the options; the session moves and the error item carries the
   *    half-done state and what is left to do by hand.
   *
   * Never rejects. Answered straight off the wire, where errors are state.
   */
  async bringBack(id: SessionId): Promise<void> {
    const state = this.meta.get(id);
    const session = this.live.get(id);
    if (!state || !session) { return; }

    const plan = await bringBackPlan(state.cwd);
    if (!plan.ok) {
      await this.refuseBringBack(id, session, plan.reason, plan.isWorktree);
      return;
    }
    // A turn in flight finishes in the tree it started in — the same rule
    // `relocate` keeps, and here it also stops git from deleting a directory
    // a running agent is working in.
    if (state.status !== 'idle') {
      await this.refuseBringBack(
        id, session,
        'This session is mid-turn. Its worktree can come back once the turn finishes.',
        true,
      );
      return;
    }

    const result = await runBringBack(plan);
    if (!result.ok) {
      // Verbatim: git-worktree writes one line per failure, and the
      // removed-but-not-checked-out one names the half-done state precisely.
      // Anything generic here would throw that away.
      await this.refuseBringBack(id, session, result.reason ?? 'The bring-back failed.', true);
      if (result.removed) { await this.moveTo(id, session, state, plan.mainRoot, plan.worktree); }
      return;
    }

    await this.moveTo(id, session, state, plan.mainRoot, plan.worktree);
  }

  /**
   * A refusal is two things: a durable record in the transcript, and a fresh
   * plan for whatever dialog is still on screen so it stops showing the
   * now-overtaken one. Neither is an exception.
   */
  private async refuseBringBack(
    id: SessionId, session: AgentSession, reason: string, isWorktree: boolean,
  ): Promise<void> {
    await session.noteError(reason);
    if (this.disposed) { return; }
    this.emit({ t: 'bring-back-plan', id, plan: { ok: false, reason, isWorktree } });
  }

  /**
   * Every linked working tree this panel still touches.
   *
   * The bring-back door lives in a pane header, which means it only exists
   * while a session is *in* the tree. A session that moved on — or a panel
   * restored after the session that made the tree was deleted — leaves
   * directories on disk nothing in the UI can reach. This sweep is how they
   * are reachable again, so its candidates are both ways a tree gets
   * remembered: the directory a session sits in, and the directories it still
   * holds resume tokens for.
   *
   * Only linked worktrees become rows. A path that is not a repository has
   * nothing to sweep, and the main tree is where a branch comes back *to* —
   * a row for it could only ever refuse. Refusals themselves are
   * `bringBackPlan`'s, verbatim: removal here is that same operation, and a
   * second set of preconditions would only be a second set of things to
   * disagree.
   */
  async staleTrees(): Promise<StaleTree[]> {
    const rows: StaleTree[] = [];
    for (const dir of this.knownDirectories()) {
      const status = await treeStatus(dir);
      if (!status.isRepo || !status.isWorktree) { continue; }
      // Two remembered paths can resolve to one tree — a session's cwd and a
      // token key for a subdirectory of it, say. One tree, one row.
      if (rows.some((row) => samePath(row.path, status.root))) { continue; }
      const plan = await bringBackPlan(status.root);
      rows.push({
        path: status.root,
        branch: status.branch,
        clean: status.clean,
        sessionId: this.occupantOf(status.root),
        reason: plan.ok ? undefined : plan.reason,
      });
    }
    return rows.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Read-only, like `requestBringBack`: safe to ask whenever the panel wants. */
  async requestStaleTrees(): Promise<void> {
    const trees = await this.staleTrees();
    if (this.disposed) { return; }
    this.emit({ t: 'stale-trees', trees });
  }

  /**
   * Every absolute path `id` is known to have written — the live session's
   * own record unioned with what its transcript remembers from before this
   * launch.
   */
  private async claimsOf(id: SessionId): Promise<Set<string>> {
    let prior = this.backfilled.get(id);
    if (!prior) {
      prior = new Set<string>();
      const state = this.meta.get(id);
      if (state) {
        // A limit past any real transcript: `tail` slices from
        // `max(0, len - limit)`, so this reads the whole file.
        const { items } = await this.store.tail(id, Number.MAX_SAFE_INTEGER);
        for (const item of items) {
          if (item.role !== 'tool') { continue; }
          for (const path of claimedPaths(item.tool, state.cwd)) { prior.add(path); }
          for (const child of item.children ?? []) {
            if (child.role !== 'tool') { continue; }
            for (const path of claimedPaths(child.tool, state.cwd)) { prior.add(path); }
          }
        }
      }
      this.backfilled.set(id, prior);
    }
    const live = this.live.get(id)?.claimedPaths;
    return live ? new Set([...prior, ...live]) : prior;
  }

  /**
   * What the fleet has changed, one row per working tree.
   *
   * A tree is the unit git can answer for; a session is the unit the user
   * thinks in. Both travel: the tree carries its occupants, each file carries
   * the sessions claiming it, and the webview derives the session grouping.
   * Sending it pre-grouped would duplicate any file two sessions claim, and
   * make the shared-file case unrepresentable without a second, contradicting
   * copy of its diff.
   *
   * Non-repositories are dropped rather than listed with a reason: a session
   * running in a plain directory has nothing to review, and a permanent row
   * saying so is noise. A directory that *is* a repository but cannot be read
   * stays, carrying why — that one is a fault worth surfacing.
   */
  async fleetDiff(): Promise<TreeDiff[]> {
    const rows: TreeDiff[] = [];

    for (const dir of this.knownDirectories()) {
      const status = await treeStatus(dir);
      if (!status.isRepo) { continue; }
      // Two remembered paths can resolve to one tree. One tree, one row.
      if (rows.some((row) => samePath(row.root, status.root))) { continue; }

      const occupants = this.sessionsIn(status.root);
      // A tree nobody sits in is somebody's abandoned worktree; the
      // stale-tree sweep is where that is dealt with, not here.
      if (occupants.length === 0) { continue; }

      const changes = await treeChanges(status.root);
      if ('reason' in changes) {
        rows.push({
          root: status.root, branch: status.branch, sessions: occupants,
          base: { kind: 'head' }, files: [], omitted: 0, reason: changes.reason,
        });
        continue;
      }

      const claimsBySession = new Map<SessionId, Set<string>>();
      for (const id of occupants) {
        const absolute = await this.claimsOf(id);
        const relative = new Set<string>();
        for (const path of absolute) {
          const rel = toRepoRelative(path, status.root);
          if (rel !== undefined) { relative.add(rel); }
        }
        claimsBySession.set(id, relative);
      }

      rows.push({
        root: status.root,
        branch: status.branch,
        sessions: occupants,
        base: changes.base,
        omitted: changes.omitted,
        files: changes.files.map((file) => ({
          ...file,
          // A rename's old path is claimed too: the session that moved a file
          // wrote both sides of it, and matching only the new path would
          // orphan every rename an agent made.
          claimedBy: occupants.filter((id) => {
            const claimed = claimsBySession.get(id);
            return claimed !== undefined
              && (claimed.has(file.path) || (file.from !== undefined && claimed.has(file.from)));
          }),
        })),
      });
    }

    return rows.sort((a, b) => a.root.localeCompare(b.root));
  }

  /**
   * Every session sitting in `root`, roster order.
   *
   * `occupantOf` answers with one session because a bring-back moves exactly
   * one; this answers with all of them, because a shared root is precisely
   * the case this surface exists to disambiguate.
   *
   * Archived sessions count here, and deliberately — unlike `occupantOf`,
   * which excludes them because resurrecting a closed session into the roster
   * behind a sweep would be a surprise. Closing a session does not undo what
   * it wrote: its changes are still uncommitted on disk and still unreviewed,
   * and this is the surface whose entire job is to show them. Dropping it
   * would hide exactly the work most likely to be forgotten. The directory
   * leaves this list when `forgetTree` erases it from the roster, which is
   * the same moment it stops being ours to describe.
   */
  private sessionsIn(root: string): SessionId[] {
    const ids: SessionId[] = [];
    for (const state of this.meta.values()) {
      if (samePath(resolve(state.cwd), root)) { ids.push(state.id); }
    }
    return ids;
  }

  /**
   * Read-only, like `requestStaleTrees`: safe to ask whenever the panel wants.
   *
   * A whole-read failure answers with a reason rather than rejecting. The
   * router's catch-all would keep a rejection from escaping `handle()`, but
   * it would also swallow the only event the surface has: nothing would be
   * emitted, and the webview would hold "Reading the working trees…" forever.
   * Errors are state — the same contract `TreeDiff.reason` already keeps for
   * a single tree, kept here for the call as a whole.
   */
  async requestFleetDiff(): Promise<void> {
    let trees: TreeDiff[];
    try {
      trees = await this.fleetDiff();
    } catch (err) {
      if (this.disposed) { return; }
      const detail = err instanceof Error ? err.message : String(err);
      this.emit({
        t: 'fleet-diff', trees: [],
        reason: `Could not read the working trees: ${detail}`,
      });
      return;
    }
    if (this.disposed) { return; }
    this.emit({ t: 'fleet-diff', trees });
  }

  /**
   * Sweeps one tree away, and answers with the refreshed sweep either way.
   *
   * Two branches, one behaviour. An **occupied** tree is the pane header's
   * bring-back reached through a different door, so it delegates to
   * `bringBack` rather than reimplementing the move: the session has to end
   * up somewhere, and there is only one code path that moves a session. An
   * **unowned** tree runs the same plan-then-act pair directly, because there
   * is no session to move and none to write an error item to.
   *
   * Which makes the refreshed sweep the refusal surface: a row that is still
   * listed, still dirty, carrying the line that stopped it. Never rejects —
   * this is answered straight off the wire, where errors are state.
   */
  async removeStaleTree(path: string): Promise<void> {
    // The sweep is the authority on which directories this panel may touch.
    // `path` arrives over `postMessage`; a path the sweep does not list is
    // one no session ever named, and it is not ours to delete.
    const target = (await this.staleTrees())
      .find((row) => samePath(row.path, resolve(path)));
    if (!target) { await this.requestStaleTrees(); return; }

    let failure: string | undefined;
    if (target.sessionId !== undefined) {
      const id = target.sessionId;
      const before = this.meta.get(id)?.cwd;
      // A session restored from `index.json` has no live run until something
      // asks for one — the same materialization `MessageRouter` does before a
      // send. `bringBack` needs a live session to dispose and rebuild.
      await this.open(id).catch(() => undefined);
      await this.bringBack(id);
      const after = this.meta.get(id)?.cwd;
      // `bringBack` moves the session if and only if the directory is gone,
      // so its cwd is the one signal that says whether to forget the tree.
      if (before !== undefined && after !== undefined
        && !samePath(resolve(before), resolve(after))) {
        this.forgetTree(target.path, after);
      }
    } else {
      // Re-planned here, never taken from the row: the sweep the user clicked
      // may have been on screen for minutes, and what it showed is a
      // description of a past state rather than an authorization.
      const plan = await bringBackPlan(target.path);
      if (!plan.ok) {
        failure = plan.reason;
      } else {
        const result = await runBringBack(plan);
        if (!result.ok) { failure = result.reason ?? 'The worktree could not be removed.'; }
        if (result.removed) { this.forgetTree(target.path, plan.mainRoot); }
      }
    }

    const trees = await this.staleTrees();
    // A git step can refuse where the plan said yes — a locked worktree is
    // clean by `status --porcelain`, so the fresh row would otherwise come
    // back looking removable and say nothing about the attempt that failed.
    if (failure !== undefined) {
      for (const row of trees) {
        if (samePath(row.path, target.path) && row.reason === undefined) { row.reason = failure; }
      }
    }
    if (this.disposed) { return; }
    this.emit({ t: 'stale-trees', trees });
  }

  /**
   * Every directory the roster remembers, deduplicated, in the platform's own
   * spelling.
   *
   * `threadKeyCwd` rather than a split on the colon: a `'global'`-scope key
   * is a bare provider id and names no directory at all, and reading one as a
   * path would put a row called `codex` in the sweep.
   */
  private knownDirectories(): string[] {
    const byKey = new Map<string, string>();
    const add = (dir: string) => {
      const full = resolve(dir);
      const key = process.platform === 'win32' ? full.toLowerCase() : full;
      if (!byKey.has(key)) { byKey.set(key, full); }
    };
    for (const state of this.meta.values()) {
      add(state.cwd);
      for (const key of Object.keys(state.resumeTokens)) {
        const dir = threadKeyCwd(key, this.providers.keys());
        if (dir !== undefined) { add(dir); }
      }
    }
    return [...byKey.values()];
  }

  /**
   * The session sitting in `root` right now, if any. Archived sessions are
   * not occupants: one is closed, and resurrecting it into the roster because
   * the user swept a directory would be a surprise. Its cwd and tokens are
   * still repaired by `forgetTree` when the tree goes.
   */
  private occupantOf(root: string): SessionId | undefined {
    for (const state of this.meta.values()) {
      if (state.archived) { continue; }
      if (samePath(resolve(state.cwd), root)) { return state.id; }
    }
    return undefined;
  }

  /**
   * Erases a removed directory from the roster: no session may still resume
   * into it, and none may still claim to be in it.
   *
   * Paths get reused, which is the whole reason the tokens go — a future
   * worktree created at the same path would otherwise inherit a conversation
   * it never had. The cwd repair covers the sessions `bringBack` did not
   * carry: an archived one, or one whose token merely named the tree.
   */
  private forgetTree(removed: string, mainRoot: string): void {
    let touched = false;
    for (const state of this.meta.values()) {
      for (const key of Object.keys(state.resumeTokens)) {
        const dir = threadKeyCwd(key, this.providers.keys());
        if (dir !== undefined && samePath(resolve(dir), removed)) {
          delete state.resumeTokens[key];
          touched = true;
        }
      }
      if (samePath(resolve(state.cwd), removed)) {
        state.cwd = mainRoot;
        state.updatedAt = Date.now();
        touched = true;
      }
    }
    if (touched) { this.changed(); }
  }

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
   * Resolves each reference against the session it names.
   *
   * Never rejects and never throws: this is answered onto the wire, where
   * errors are state. A ref naming a deleted session, or one whose source has
   * produced nothing of that kind yet, comes back in `missing` for the caller
   * to report into the receiving transcript.
   *
   * A live session is asked through `snapshot()`, which flushes its pending
   * writes first — without that, a payload from a turn that ended moments ago
   * would still be sitting in the store's queue and resolve as absent.
   */
  async resolveRefs(
    refs: SessionRef[],
  ): Promise<{ blocks: ResolvedBlock[]; missing: SessionRef[] }> {
    const blocks: ResolvedBlock[] = [];
    const missing: SessionRef[] = [];

    for (const ref of refs) {
      if (!this.meta.has(ref.sessionId)) { missing.push(ref); continue; }
      const live = this.live.get(ref.sessionId);
      const items = live
        ? (await live.snapshot()).items
        : (await this.store.tail(ref.sessionId)).items;
      const text = findPayload(items, ref.kind, live?.openItemId);
      if (text === undefined) { missing.push(ref); continue; }
      blocks.push({ title: ref.title, kind: ref.kind, text });
    }

    return { blocks, missing };
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
        this.emitSnapshot(id, snapshot);
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
      this.emitSnapshot(id, {
        ...state, items, hasMore, pending: [],
        invocables: this.catalogSvc.get(this.keyOf(state)),
        // An archived session has no run to ask, and a stale snapshot
        // presented as current would be a lie.
        mcpServers: [],
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
    // Before the dispose below, which can report a final status: a closed
    // session must not relocate on its way out.
    this.queuedMoves.delete(id);
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
    this.queuedMoves.clear();
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
    if (status === 'idle') { this.drainQueuedMove(id); }
  }

  /**
   * Performs a relocation the user asked for mid-turn, now that the turn is
   * over. Called from the sink — i.e. from a session's event pump — so it is
   * synchronous and must never reject: a rejection here escapes into the pump
   * as an unhandled one.
   *
   * The entry is taken out of the map *before* the first await. `moveTo`
   * disposes and rebuilds the session, and a dispose can report a status of
   * its own; removing first is what stops that from re-entering here and
   * moving twice.
   */
  private drainQueuedMove(id: SessionId): void {
    const itemId = this.queuedMoves.get(id);
    if (itemId === undefined) { return; }
    this.queuedMoves.delete(id);
    if (this.disposed || !this.live.has(id)) { return; }
    void this.performQueuedMove(id, itemId).catch(() => {
      // Errors are state. The move records what it can in the transcript;
      // there is nothing to throw at from an event pump.
    });
  }

  /**
   * The deferred half of `relocate`. Not `relocate` itself: that one only
   * accepts a `pending` offer, and the item this performs is `queued` — the
   * mark it was given when the click arrived. Re-reading it here rather than
   * trusting the map is what makes a cancel between the click and idle stick.
   */
  private async performQueuedMove(id: SessionId, itemId: string): Promise<void> {
    const state = this.meta.get(id);
    const session = this.live.get(id);
    if (!state || !session) { return; }

    const item = await this.store.find(id, itemId);
    if (!item || item.role !== 'relocation' || item.state !== 'queued') { return; }

    await this.settleRelocation(id, session, state, item, true);
  }

  /**
   * Straight through, no dedupe: each session already reports its own profile
   * failure once, and whether a *window* should say it more than once is the
   * host's call, not the roster's.
   */
  shellNoise(profile: string): void {
    this.onShellNoise(profile);
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
      version: TRANSCRIPT_VERSION,
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
