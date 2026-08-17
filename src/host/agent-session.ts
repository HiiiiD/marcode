import { resolve } from 'node:path';
import type {
  McpServerStatus, PermissionRequest, QuestionRequest, SessionId, SessionRef, SessionSnapshot,
  SessionState, SessionStatus, TranscriptItem, TranscriptPatch,
} from '../protocol/messages';
import type { ToolCall, ToolOutput } from '../providers/canonical/tool-call';
import type {
  AgentEvent, AgentProvider, AgentRun,
  ContextBreakdown,
  EditorContext,
  EffortLevel, Invocable, PermissionMode, QuestionAnswers, ToolDecision,
  UsageWindow,
} from '../providers/types';
import { findModel, resolveEffort } from '../shared/model-catalog';
import { threadKey } from '../shared/thread-key';
import { claimedPaths } from './claim-paths';
import { profileNoiseIn } from './profile-noise';
import { persistableAnswers } from './question-persistence';
import type { TranscriptStore } from './transcript-store';
import { detectWorktreeAdd } from './worktree-detect';

export interface SessionSink {
  patch(id: SessionId, patch: TranscriptPatch): void;
  status(id: SessionId, status: SessionStatus): void;
  mcp(id: SessionId, servers: McpServerStatus[]): void;
  changed(): void;
  /**
   * A running session reported its catalog. Goes UP to the manager, which
   * owns the per-cwd cache and the fan-out; it is not this session's answer
   * alone.
   */
  invocables(id: SessionId, entries: Invocable[]): void;
  /**
   * A session pulled a whole window set for its provider. Keyed by provider,
   * not by session: plan limits belong to the account. A whole set, not one
   * window, because a pull is a snapshot — see SessionManager.usageWindows.
   */
  usageWindows(providerId: string, windows: UsageWindow[] | undefined): void;
  /**
   * A shell command came back carrying a PowerShell profile's own load
   * failure. Optional: a sink that has nowhere to put the advice may ignore
   * it, and every existing sink stays valid without one.
   *
   * Reported at most once per session — the profile loads for every command,
   * so the condition repeats even though the news does not. See
   * `host/profile-noise.ts` for why the extension cannot fix it from here.
   */
  shellNoise?(profile: string): void;
}

const TITLE_MAX = 60;

/**
 * Whether two absolute paths name the same directory.
 *
 * Both sides must already be `resolve`d: the session's `cwd` is whatever the
 * creator supplied, so comparing a resolved candidate against a raw `cwd`
 * makes `/repo` and `C:\repo` look like different trees. Case is folded on
 * win32 only, where the filesystem is case-insensitive and `C:\Repo` is the
 * same directory as `C:\repo`; folding it elsewhere would merge two paths that
 * genuinely differ.
 */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

/**
 * A tool call the turn ended without settling, as an errored item.
 *
 * The stand-in output is only used when the call reported none: a provider
 * that streamed partial output before dying said something the user should
 * keep, and overwriting it with a generic sentence would be a worse card
 * than the one it replaces.
 */
function unsettled(item: ToolItem): ToolItem {
  return {
    ...item,
    state: 'error',
    output: item.output ?? {
      kind: 'text', text: 'The agent ended this turn without reporting a result.',
    },
  };
}

let counter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

export class AgentSession {
  private run: AgentRun;
  private pending = new Map<string, PermissionRequest>();
  private pendingQuestions = new Map<string, QuestionRequest>();
  private openAssistantId: string | undefined;
  private toolItems = new Map<string, TranscriptItem>();
  private permissionItems = new Map<string, TranscriptItem>();
  private questionItems = new Map<string, TranscriptItem>();
  /** Provider tool id -> the buffered children of that (parent) tool call. */
  private childrenByParent = new Map<string, TranscriptItem[]>();
  /** Provider tool id of a child -> the provider tool id of its parent. */
  private childOf = new Map<string, string>();
  /** Permission request id -> the provider tool id of the subagent it nests under. */
  private permissionChildOf = new Map<string, string>();
  /**
   * Every absolute path this session's tool calls have written, this launch.
   *
   * Not persisted, and deliberately: a claim describes a tree at an instant,
   * and a restored claim would describe an install nobody checked this
   * launch — the same reason a failed model probe never reaches
   * `catalog.json`. `SessionManager` rebuilds the pre-launch part from the
   * transcript on demand instead.
   */
  private readonly claims = new Set<string>();
  private pumping: Promise<void>;
  /**
   * The editor context captured when the parked message was typed, not when
   * it is finally sent: the user attached the file they were looking at
   * mid-turn, and re-reading the editor minutes later would attach a
   * different one.
   */
  private queuedContext: EditorContext | undefined;
  private disposed = false;
  /**
   * TranscriptStore.flush() is not safe to call concurrently for the same
   * session id — two overlapping calls can both observe the same pending
   * queue before either clears it, duplicating writes. We only ever flush
   * this session, so chain every flush onto the previous one to serialize.
   * This chain never rejects (see scheduleFlush): a rejected link here
   * would otherwise surface as an unhandled rejection at the fire-and-forget
   * call sites, or reject out of dispose()/snapshot() for no actionable
   * reason.
   */
  private flushChain: Promise<void> = Promise.resolve();
  /**
   * The cwd catalog as last told to us by the manager. Held only so
   * snapshot() can carry it; this session is not its owner.
   */
  private invocableEntries: Invocable[] | undefined;
  /**
   * Live provider state only — never persisted, never on SessionState.
   * An archived session reports none, because there is no run to ask.
   */
  private mcpServers: McpServerStatus[] = [];
  /**
   * How many transcript items this run has appended. Counted here rather
   * than read back from the store so `isEmpty` stays synchronous and needs
   * no disk read on the close path.
   */
  private appended = 0;
  /** A profile failure has already been reported up; every later one is the same news. */
  private shellNoiseReported = false;

  constructor(
    private readonly _state: SessionState,
    private readonly provider: AgentProvider,
    private readonly store: TranscriptStore,
    private readonly sink: SessionSink,
    /**
     * Prepended to the first send of a thread with no history of this
     * conversation. Spent once, then cleared — a second send continues a
     * thread that now remembers.
     */
    private seed?: string,
  ) {
    this.run = provider.start({
      cwd: _state.cwd,
      model: _state.model,
      effort: _state.effort,
      permissionMode: _state.permissionMode,
      resumeToken: _state.resumeTokens[
        threadKey(provider.id, provider.threadScope, _state.cwd)
      ],
    });
    this.pumping = this.pump();
  }

  get state(): SessionState { return this._state; }

  get claimedPaths(): ReadonlySet<string> {
    return this.claims;
  }

  /**
   * Tells the sink, once, that this session's shell is loading a profile that
   * fails under Codex's redirected `pwsh -Command` wrapper.
   *
   * Gated on `kind: 'command'` deliberately: the same frame appearing in a
   * `file-read` is an agent looking at a profile, which says nothing about the
   * shell this session actually runs in.
   */
  private reportShellNoise(item: ToolItem): void {
    if (this.shellNoiseReported || item.tool.kind !== 'command') { return; }
    const output = item.output;
    if (output?.kind !== 'text') { return; }
    const profile = profileNoiseIn(output.text);
    if (!profile) { return; }
    this.shellNoiseReported = true;
    this.sink.shellNoise?.(profile);
  }

  /**
   * Nothing has been appended by *this* run. A run revived by
   * `SessionManager.open()` starts at zero even though the store holds the
   * earlier transcript, so this is only an answer about the live run — the
   * manager pairs it with the persisted transcript before concluding a
   * session is genuinely empty.
   */
  get isEmpty(): boolean { return this.appended === 0; }

  /**
   * The replay still waiting to be spent, if any. Exists for tests and for
   * `SessionManager`, which is the only thing that ever supplies one.
   */
  get pendingSeedText(): string | undefined { return this.seed; }

  /**
   * The assistant item currently being streamed into, if any.
   *
   * Exposed for reference resolution: an in-flight answer must never be what
   * a handoff pulls, and this is the only place that knows which item it is.
   */
  get openItemId(): string | undefined { return this.openAssistantId; }

  // `noteError` arrived on both sides of this merge — handoff needed it for an
  // unresolvable reference, relocation for a refused bring-back. One
  // definition survives, below, and it is the awaited one: bring-back disposes
  // and rebuilds the session immediately after noting, so a fire-and-forget
  // flush could lose the item to the rebuild. Handoff's callers do not await
  // it, which is harmless — `scheduleFlush` never rejects.

  /** A turn is in flight, so a send would have to interleave with it. */
  private get busy(): boolean {
    return this._state.status === 'running' || this._state.status === 'awaiting-approval';
  }

  /**
   * Sends, or parks the message until the turn in flight is over.
   *
   * Draining first is what makes the order first-in-first-out: a session sent
   * to while it is idle *and* holding a parked message — which is where an
   * errored turn leaves it — sends the parked one and parks the new one
   * behind it, rather than overwriting words the user already committed to.
   */
  send(text: string, context?: EditorContext, refs?: SessionRef[]): void {
    if (!this.busy) { this.drainQueued(); }
    if (this.busy) {
      this._state.queued = { text, ...(refs && refs.length > 0 ? { refs } : {}) };
      this.queuedContext = context;
      this._state.updatedAt = Date.now();
      this.sink.changed();
      return;
    }
    this.deliver(text, context, refs);
  }

  /** Drops the parked message. Nothing was ever appended, so nothing is undone. */
  cancelQueued(): void {
    if (!this._state.queued) { return; }
    this._state.queued = undefined;
    this.queuedContext = undefined;
    this._state.updatedAt = Date.now();
    this.sink.changed();
  }

  /**
   * Spends the parked message if the session can take one now. Called at the
   * turn boundary and before any fresh send; a no-op when there is nothing
   * parked or the session is still busy.
   */
  private drainQueued(): void {
    const queued = this._state.queued;
    if (!queued || this.busy) { return; }
    const context = this.queuedContext;
    this._state.queued = undefined;
    this.queuedContext = undefined;
    this.deliver(queued.text, context, queued.refs);
  }

  private deliver(text: string, context?: EditorContext, refs?: SessionRef[]): void {
    if (this._state.title === 'Untitled' && text.trim().length > 0) {
      this._state.title = text.trim().slice(0, TITLE_MAX);
    }
    const item: TranscriptItem = {
      id: nextId('u'), ts: Date.now(), role: 'user', text,
      ...(context ? { context } : {}),
      ...(refs && refs.length > 0 ? { refs } : {}),
    };
    this.appendItem(item);
    this.closeAssistant();
    this.setStatus('running');
    // The transcript item above deliberately recorded `text`, never
    // `outgoing`: a seed is context handed to the provider, not something the
    // user wrote, and writing it into the transcript would both duplicate the
    // history it summarizes and put words in the user's mouth.
    const outgoing = this.seed ? `${this.seed}\n\n---\n\n${text}` : text;
    this.seed = undefined;
    try {
      this.run.send(outgoing, context);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  async interrupt(): Promise<void> {
    try {
      await this.run.interrupt();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  setEffort(effort: EffortLevel): void {
    this._state.effort = effort;
    this._state.updatedAt = Date.now();
    try {
      this.run.setEffort(effort);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }
    this.sink.changed();
  }

  /**
   * Valid at any point in the conversation, not only before the first
   * message: `AgentRun.setModel` retargets the live run, so this is a real
   * switch rather than a recording. A turn already in flight finishes on the
   * model it started with.
   *
   * Effort travels with the model, because it belongs to the model and not
   * to the session (see resolveEffort): switching to a model with no effort
   * control drops the level entirely, and switching to one that offers a
   * different set clamps to its default. Without this a session created on
   * Opus and switched to Haiku would run Haiku at an effort it cannot take,
   * while the composer — which hangs the effort control off the model row —
   * showed no control to fix it with. The reconciled level goes to the run on
   * both sides of the first send, for the same reason the model itself does.
   */
  setModel(model: string): void {
    const previousEffort = this._state.effort;
    const effort = resolveEffort(findModel(this.provider.listModels(), model), previousEffort);
    this._state.model = model;
    this._state.effort = effort;
    this._state.updatedAt = Date.now();
    try {
      this.run.setModel(model);
      if (effort !== undefined && effort !== previousEffort) {
        this.run.setEffort(effort);
      }
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }
    this.sink.changed();
  }

  /**
   * Always goes through the live run.setPermissionMode() seam, in either
   * direction — including into and out of 'bypass'. ClaudeProvider itself
   * decides whether that means updating a not-yet-constructed session's
   * pending options or calling the SDK's live Query.setPermissionMode,
   * depending on whether this session's first message has been sent yet;
   * AgentSession does not need to know which.
   */
  setPermissionMode(mode: PermissionMode): void {
    this._state.permissionMode = mode;
    this._state.updatedAt = Date.now();
    try {
      this.run.setPermissionMode(mode);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }
    this.sink.changed();
  }

  setInvocables(entries: Invocable[]): void {
    // Replace wholesale: the catalog is always a full list.
    this.invocableEntries = entries;
  }
  
  setIncludeEditorContext(on: boolean): void {
    this._state.includeEditorContext = on;
    this._state.updatedAt = Date.now();
    this.sink.changed();
  }

  respondToPermission(requestId: string, decision: ToolDecision): void {
    if (!this.pending.delete(requestId)) { return; }
    try {
      this.run.respondToTool(requestId, decision);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The provider rejected the decision, so the request is no longer
      // outstanding as far as it's concerned. Settle the persisted item as
      // denied (rather than leaving it 'pending' forever with no way for
      // the user to retry, since `pending` no longer has this requestId).
      const existing = this.permissionItems.get(requestId);
      if (existing && existing.role === 'permission') {
        const settled: TranscriptItem = { ...existing, state: 'denied', reason: message };
        const parentRoot = this.permissionChildOf.get(requestId);
        if (parentRoot) { this.replaceChild(parentRoot, settled); }
        else { this.replaceItem(settled); }
        this.permissionItems.set(requestId, settled);
      }
      this.fail(message);
      return;
    }

    const existing = this.permissionItems.get(requestId);
    if (existing && existing.role === 'permission') {
      const settled: TranscriptItem = {
        ...existing,
        state: decision.allow ? 'allowed' : 'denied',
        reason: decision.allow ? undefined : decision.reason,
      };
      const parentRoot = this.permissionChildOf.get(requestId);
      if (parentRoot) { this.replaceChild(parentRoot, settled); }
      else { this.replaceItem(settled); }
      this.permissionItems.set(requestId, settled);
    }
    this.recomputeWaitingStatus();
  }

  /**
   * Answers a parked question. A double answer — a second click on a card
   * already settled — is a no-op rather than a failure: the request is gone
   * from `pendingQuestions` after the first answer, so this mirrors the early
   * return in `respondToPermission` that stops a second click from stranding
   * the card with no way to retry.
   */
  answerQuestion(requestId: string, answers: QuestionAnswers): void {
    if (!this.pendingQuestions.delete(requestId)) { return; }
    this.replaceQuestionItem(requestId, 'answered', answers);
    this.run.respondToQuestion(requestId, answers);
    this.recomputeWaitingStatus();
  }

  /**
   * Settles a request cancelled out from under the host — an abort or an
   * explicit interrupt racing a parked permission or question (Claude raises
   * `request-cancelled` for both; see `cancelParked` in claude-provider.ts).
   * The provider has already resolved its own side by the time this arrives,
   * so this only reconciles host state: without it, the card stays rendered
   * `pending` and `recomputeWaitingStatus` leaves the session stuck at
   * `awaiting-approval` forever, with a later Allow/Deny/answer click
   * silently no-opping against a request the provider already discarded.
   *
   * A permission settles as `denied` with reason `'Turn cancelled'` — the
   * permission item's state union stays `pending | allowed | denied`
   * (widening it is a wire/type change no task here owns), and `denied` with
   * that reason is exactly what the provider's own `cancelParked` already
   * resolved with, so host and provider agree. A question settles into its
   * own `'cancelled'` state.
   */
  private settleRequest(requestId: string, state: 'cancelled'): void {
    if (this.pending.delete(requestId)) {
      const existing = this.permissionItems.get(requestId);
      if (existing && existing.role === 'permission') {
        const settled: TranscriptItem = { ...existing, state: 'denied', reason: 'Turn cancelled' };
        const parentRoot = this.permissionChildOf.get(requestId);
        if (parentRoot) { this.replaceChild(parentRoot, settled); }
        else { this.replaceItem(settled); }
        this.permissionItems.set(requestId, settled);
      }
      this.recomputeWaitingStatus();
      return;
    }
    if (!this.pendingQuestions.delete(requestId)) { return; }
    this.replaceQuestionItem(requestId, state);
    this.recomputeWaitingStatus();
  }

  /**
   * Replaces a parked question's transcript item with its settled state.
   *
   * `answers` is the caller's unredacted set — `answerQuestion` still sends
   * that one to `run.respondToQuestion` — and is redacted here, against this
   * request's own `QuestionSpec[]`, before it ever reaches `replaceItem` or
   * `this.store`. Getting the two the wrong way round either leaks a secret
   * onto disk or answers the agent with an empty value.
   */
  private replaceQuestionItem(
    requestId: string, state: 'answered' | 'cancelled', answers?: QuestionAnswers,
  ): void {
    const existing = this.questionItems.get(requestId);
    if (!existing || existing.role !== 'question') { return; }
    const persisted = answers ? persistableAnswers(existing.questions, answers) : undefined;
    const settled: TranscriptItem = { ...existing, state, ...(persisted ? { answers: persisted } : {}) };
    this.replaceItem(settled);
    this.questionItems.set(requestId, settled);
  }

  /**
   * The one place that recomputes `awaiting-approval` vs. an idle status —
   * used wherever a permission or question request settles. `idle` names
   * what "not waiting" means at the call site: `running` mid-turn,
   * `idle` once a turn has ended.
   */
  private recomputeWaitingStatus(idle: SessionStatus = 'running'): void {
    const waiting = this.pending.size > 0 || this.pendingQuestions.size > 0;
    this.setStatus(waiting ? 'awaiting-approval' : idle);
  }

  /**
   * Rejects rather than returning a sentinel when the provider does not
   * implement this: SessionManager is the single place that converts a
   * failure into the `{ ok: false, reason }` the wire carries, so there is
   * exactly one shape of "unavailable" reaching the webview.
   */
  async contextBreakdown(): Promise<ContextBreakdown> {
    if (!this.run.contextBreakdown) {
      throw new Error('This provider does not report context usage');
    }
    const breakdown = await this.run.contextBreakdown();
    // A live answer supersedes whatever the last turn recorded, so the cache
    // a reloaded window will read is updated from it — and so is the pushed
    // percentage, because the ring, its danger threshold and the popover
    // header must all be the same measurement. A destructive 86% ring beside
    // a "50% used" header is two numbers claiming to be one thing.
    this.applyContextPercent(breakdown);
    return breakdown;
  }

  /**
   * Whether this session's most recent breakdown listed `path`. The webview
   * can only ask to open a memory file it was shown, so the set it was last
   * shown is exactly the set the host will act on — see
   * SessionManager.canOpenFile.
   */
  reportedMemoryFile(path: string): boolean {
    return this.memoryPaths.has(path);
  }

  private memoryPaths = new Set<string>();

  private rememberMemoryFiles(breakdown: ContextBreakdown): void {
    this.memoryPaths = new Set(breakdown.memoryFiles.map((f) => f.path));
  }

  /**
   * Best-effort: the ring is decoration over a live conversation, so a
   * provider that fails to answer must not turn a completed turn into an
   * error item. Fire-and-forget from handle(), hence the internal catch —
   * a rejection here would otherwise be an unhandled rejection.
   */
  private async refreshContextPercent(): Promise<void> {
    try {
      const breakdown = await this.run.contextBreakdown?.();
      if (!breakdown) { return; }
      this.applyContextPercent(breakdown);
    } catch {
      // See the doc comment: an unavailable breakdown is not a failed turn.
    }
  }

  /**
   * Best-effort, exactly like refreshContextPercent: the strip is decoration
   * over a live conversation, so a provider that cannot answer must not turn
   * a completed turn into an error item. Fire-and-forget from handle(),
   * hence the internal catch — a rejection here would otherwise be an
   * unhandled rejection.
   */
  private async refreshUsage(): Promise<void> {
    if (!this.run.usageWindows) { return; }
    try {
      const windows = await this.run.usageWindows();
      if (this.disposed) { return; }
      this.sink.usageWindows(this._state.providerId, windows);
    } catch {
      // See the doc comment: an unavailable pull is not a failed turn.
    }
  }

  /**
   * The one place `contextPercent` and `lastContext` are written, so the
   * ring, its danger threshold and the popover header — everything
   * downstream of those fields — are always the same measurement as of the
   * breakdown that produced it.
   */
  private applyContextPercent(breakdown: ContextBreakdown): void {
    if (this.disposed) { return; }
    this.rememberMemoryFiles(breakdown);
    const next = Math.round(100 - breakdown.freePercent);
    // The percentage can be unchanged while the inventory behind it is not —
    // one memory file added and another dropped, say — and the stored
    // breakdown is what a reloaded window answers `request-context` from. So
    // the guard covers both, and `changed()` (which is what schedules the
    // write to index.json) fires whenever either moved.
    const same = this._state.contextPercent === next
      && JSON.stringify(this._state.lastContext) === JSON.stringify(breakdown);
    if (same) { return; }
    this._state.contextPercent = next;
    this._state.lastContext = breakdown;
    this._state.updatedAt = Date.now();
    this.sink.changed();
  }

  async snapshot(): Promise<SessionSnapshot> {
    await this.scheduleFlush();
    const { items, hasMore } = await this.store.tail(this._state.id);
    return {
      ...this._state, items, hasMore, pending: [...this.pending.values()],
      pendingQuestions: [...this.pendingQuestions.values()],
      invocables: this.invocableEntries,
      mcpServers: this.mcpServers,
    };
  }

  async loadMore(beforeItemId: string) {
    return this.store.before(this._state.id, beforeItemId);
  }

  async dispose(): Promise<void> {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const requestId of [...this.pending.keys()]) {
      this.pending.delete(requestId);
      try {
        this.run.respondToTool(requestId, { allow: false, reason: 'Session closed' });
      } catch {
        // Best-effort: the provider is being torn down regardless.
      }
    }
    // Dropped, not answered. `respondToQuestion` has no "declined" spelling —
    // its only argument is a set of answers — and the neutral `{}` does not
    // mean the same thing to both backends: codex reads it as "answered
    // nothing", while Claude turns it into `{behavior:'allow', updatedInput:
    // {...input, answers:{}}}`, i.e. run the tool with no answer at all. So
    // cancelling is the provider's own job, in its own vocabulary, and every
    // AgentRun.dispose() does it (claude-provider's `parked` loop resolves its
    // CANCELLED sentinel; CodexRun.cancelParkedQuestions responds with the
    // empty map). Clearing here only keeps host state honest for the
    // `flushUnsettledTools`/`scheduleFlush` that follow.
    this.pendingQuestions.clear();
    try {
      await this.run.dispose();
    } catch {
      // Best-effort: nothing left to report a failure into once disposed.
    }
    await this.pumping;
    this.flushUnsettledTools();
    await this.scheduleFlush();
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.run.events) { this.handle(event); }
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private handle(event: AgentEvent): void {
    switch (event.kind) {
      case 'session':
        this._state.resumeTokens[
          threadKey(this.provider.id, this.provider.threadScope, this._state.cwd)
        ] = event.resumeToken;
        this.sink.changed();
        return;

      case 'text':
      case 'thinking': {
        const field = event.kind === 'text' ? 'text' : 'thinking';
        if (!this.openAssistantId) {
          const item: TranscriptItem = {
            id: nextId('a'), ts: Date.now(), role: 'assistant', text: '',
          };
          this.openAssistantId = item.id;
          this.appendItem(item);
        }
        this.mergeDelta(this.openAssistantId, field, event.delta);
        return;
      }

      case 'tool-start': {
        const item: TranscriptItem = {
          id: nextId('t'), ts: Date.now(), role: 'tool',
          toolId: event.id, tool: event.tool, state: 'running',
        };
        this.toolItems.set(event.id, item);

        const parentItemId = event.parentId
          ? this.parentItemIdFor(event.parentId)
          : undefined;
        if (event.parentId && parentItemId) {
          const root = this.resolveParent(event.parentId);
          this.childOf.set(event.id, root);
          const children = this.childrenByParent.get(root) ?? [];
          children.push(item);
          this.childrenByParent.set(root, children);
          // Deliberately no closeAssistant() here: a subagent's tool
          // activity interleaves with the parent's prose, and splitting the
          // open assistant item on every child would shred one reply into
          // a dozen bubbles.
          this.sink.patch(this._state.id, { op: 'append', item, parentItemId });
          this._state.updatedAt = Date.now();
          return;
        }

        this.closeAssistant();
        this.appendItem(item);
        return;
      }

      case 'tool-end': {
        const existing = this.toolItems.get(event.id);
        if (!existing || existing.role !== 'tool') { return; }
        const children = this.childrenByParent.get(event.id);
        const settled: TranscriptItem = {
          ...existing,
          state: event.ok ? 'ok' : 'error',
          output: event.output,
          // A provider that only learns the real arguments on completion says
          // so by sending them again — see `AgentEvent`'s `tool-end`. Absent,
          // the tool-start call stands.
          ...(event.tool ? { tool: event.tool } : {}),
          ...(children ? { children: [...children] } : {}),
        };
        this.toolItems.set(event.id, settled);
        this.reportShellNoise(settled);

        // Above the subagent branch below on purpose. `offerRelocation` skips
        // subagent tool-ends because a subagent's worktree has no claim on
        // where the parent conversation lives; attribution is the opposite
        // case — a subagent's edit changed *this* session's tree and is this
        // session's change on disk, so it must be recorded before that early
        // return.
        //
        // Recorded whether or not the call succeeded: a failed edit can still
        // have moved bytes, and a claim is "this session wrote here", not
        // "this session succeeded here". The diff decides what is actually
        // there; a claimed path with no diff is simply never listed.
        for (const path of claimedPaths(settled.tool, this._state.cwd)) {
          this.claims.add(path);
        }

        const parentRoot = this.childOf.get(event.id);
        if (parentRoot) {
          this.replaceChild(parentRoot, settled);
          // Deliberately no relocation offer here. A subagent's worktree is a
          // side quest — it has no claim on where the parent conversation
          // lives — and a fan-out of subagents doing tree work would post one
          // card each, all but one of them noise.
          return;
        }
        this.childrenByParent.delete(event.id);
        this.replaceItem(settled);
        this.offerRelocation(settled.tool, event.ok, settled.output);
        return;
      }

      case 'permission': {
        // The permission id is the tool-use id of the call being approved,
        // so a permission raised inside a subagent resolves through the
        // same child map its tool-start populated. Providers that report a
        // parent explicitly are honoured first.
        const parentSource = event.parentId ?? this.childOf.get(event.id);
        const parentItemId = parentSource
          ? this.parentItemIdFor(parentSource)
          : undefined;

        // `meta` is spread conditionally, never written as an explicit
        // `undefined`: it reaches both the JSONL and the wire, where an
        // absent key and a present-but-undefined one are the same value but
        // not the same object.
        const meta = event.meta ? { meta: event.meta } : {};
        const item: TranscriptItem = {
          id: nextId('p'), ts: Date.now(), role: 'permission',
          requestId: event.id, tool: event.tool, state: 'pending', ...meta,
        };
        this.permissionItems.set(event.id, item);
        this.pending.set(event.id, { requestId: event.id, tool: event.tool, ...meta });

        if (parentSource && parentItemId) {
          const root = this.resolveParent(parentSource);
          const children = this.childrenByParent.get(root) ?? [];
          children.push(item);
          this.childrenByParent.set(root, children);
          this.permissionChildOf.set(event.id, root);
          this.sink.patch(this._state.id, { op: 'append', item, parentItemId });
          this._state.updatedAt = Date.now();
        } else {
          this.closeAssistant();
          this.appendItem(item);
        }
        this.setStatus('awaiting-approval');
        return;
      }

      case 'question': {
        const item: TranscriptItem = {
          id: nextId('q'), ts: Date.now(), role: 'question',
          requestId: event.id, questions: event.questions, blocking: event.blocking,
          state: 'pending',
        };
        this.questionItems.set(event.id, item);
        this.pendingQuestions.set(event.id, {
          requestId: event.id, questions: event.questions, blocking: event.blocking,
        });
        this.closeAssistant();
        this.appendItem(item);
        this.setStatus('awaiting-approval');
        return;
      }

      case 'request-cancelled':
        this.settleRequest(event.id, 'cancelled');
        return;

      case 'invocables':
        this.sink.invocables(this._state.id, event.entries);
        return;

      case 'usage':
        this._state.usage = {
          inputTokens: event.inputTokens, outputTokens: event.outputTokens,
        };
        this.sink.changed();
        return;

      case 'usage-stale':
        void this.refreshUsage();
        return;

      case 'mcp-servers':
        // Replace-whole, not a merge: the provider always sends the full
        // array, so hydrate and live update are the same code path.
        this.mcpServers = event.servers;
        this.sink.mcp(this._state.id, event.servers);
        return;

      case 'turn-end':
        this.closeAssistant();
        this.flushUnsettledTools();
        if (event.reason === 'error') {
          this.fail(event.error ?? 'Agent run failed');
        } else {
          // A permission raised earlier in the same event batch (e.g. inside
          // a subagent) can still be outstanding when turn-end arrives —
          // unconditionally going idle here would strand its card as the
          // only sign anything is waiting, with the status dot claiming
          // otherwise.
          this.recomputeWaitingStatus('idle');
          // After the status, never before: drainQueued() only fires once the
          // session is genuinely idle, and an interrupted turn reaches here
          // the same way a completed one does — which is what makes Stop a
          // way to send the parked message now.
          this.drainQueued();
          void this.scheduleFlush();
          void this.refreshContextPercent();
          void this.refreshUsage();
        }
        return;
    }
  }

  /**
   * Offers to follow the agent into a worktree it just created. The path is
   * resolved against this session's cwd because the agent's command was run
   * there, and a relative path in the transcript would be meaningless to the
   * host.
   */
  private offerRelocation(tool: ToolCall, ok: boolean, output?: ToolOutput): void {
    const found = detectWorktreeAdd(tool, ok, output);
    if (found === undefined) { return; }
    const path = resolve(this._state.cwd, found);
    if (samePath(path, resolve(this._state.cwd))) { return; }
    this.appendItem({
      id: nextId('r'), ts: Date.now(), role: 'relocation', path, state: 'pending',
    });
    void this.scheduleFlush();
  }

  /**
   * Settles a relocation offer in place. The manager owns the decision — it
   * is the only thing that can actually move a session — so this is a thin
   * seam rather than a method with a policy of its own. Flushed eagerly
   * because the very next thing the manager does on a move is dispose this
   * session and rebuild it, and an unflushed replace would be read back as
   * still pending.
   */
  async replaceRelocation(item: TranscriptItem): Promise<void> {
    this.replaceItem(item);
    await this.scheduleFlush();
  }

  /**
   * Records something that failed *around* the conversation rather than in it
   * — a refused bring-back, say. Deliberately not `fail()`: the status is
   * untouched, because the session itself is intact and an `error` badge would
   * claim the provider had died. The transcript item is the whole record, and
   * it is flushed eagerly so it survives even if the manager goes on to
   * dispose and rebuild this session.
   */
  async noteError(message: string): Promise<void> {
    this.appendItem({ id: nextId('e'), ts: Date.now(), role: 'error', message });
    await this.scheduleFlush();
  }

  private fail(message: string): void {
    this.appendItem({ id: nextId('e'), ts: Date.now(), role: 'error', message });
    this.setStatus('error');
    void this.scheduleFlush();
  }

  /**
   * Serializes calls into TranscriptStore.flush(), which is not safe to
   * overlap. Always resolves — a flush failure is swallowed here rather
   * than rejecting, so it can never become an unhandled rejection at a
   * fire-and-forget call site and can never reject out of dispose()/
   * snapshot() for the caller.
   */
  private scheduleFlush(): Promise<void> {
    this.flushChain = this.flushChain
      .then(
        () => this.store.flush(this._state.id),
        () => this.store.flush(this._state.id),
      )
      .catch(() => { /* swallowed: see flushChain doc comment above */ });
    return this.flushChain;
  }

  private appendItem(item: TranscriptItem): void {
    this.appended++;
    this.store.append(this._state.id, item);
    this._state.updatedAt = Date.now();
    this.sink.patch(this._state.id, { op: 'append', item });
  }

  private replaceItem(item: TranscriptItem): void {
    this.store.replace(this._state.id, item);
    this._state.updatedAt = Date.now();
    this.sink.patch(this._state.id, { op: 'replace', item });
  }

  /**
   * Resolves a reported parent to the top-level tool call it belongs under.
   *
   * Claude subagents cannot spawn subagents, so a reported grandchild means
   * a provider we did not anticipate. Walking up to the nearest depth-1
   * ancestor flattens it rather than growing the data model into a tree.
   * The iteration cap keeps a malformed cycle from hanging the pump.
   */
  private resolveParent(parentId: string): string {
    let current = parentId;
    for (let hops = 0; hops < 8; hops++) {
      const next = this.childOf.get(current);
      if (next === undefined) { return current; }
      current = next;
    }
    return current;
  }

  /** The transcript item id of a resolved parent, if we ever saw its tool-start. */
  private parentItemIdFor(parentId: string): string | undefined {
    const root = this.resolveParent(parentId);
    const item = this.toolItems.get(root);
    return item && item.role === 'tool' ? item.id : undefined;
  }

  /**
   * Settles an item that lives inside a parent's children buffer.
   *
   * While the parent tool call is still running, its children are not in
   * the store yet — they land there inline when the parent settles — so
   * this just updates the buffer and streams a patch, with no store write.
   *
   * But `flushUnsettledTools` can have already settled the parent (e.g.
   * an interrupt mid-subagent) and cleared the buffer, while a permission
   * raised inside it is still outstanding and answered later. In that case
   * the parent's persisted `children` array is the only durable copy, so
   * this rebuilds the parent item with the child updated in place and
   * writes it through `replaceItem` — one store write and one patch that
   * swaps the whole parent, children included.
   */
  private replaceChild(parentRoot: string, item: TranscriptItem): void {
    const buffered = this.childrenByParent.get(parentRoot);
    if (buffered) {
      const at = buffered.findIndex((c) => c.id === item.id);
      if (at >= 0) { buffered[at] = item; } else { buffered.push(item); }
      const parentItemId = this.parentItemIdFor(parentRoot);
      this._state.updatedAt = Date.now();
      this.sink.patch(this._state.id, { op: 'replace', item, parentItemId });
      return;
    }

    const parent = this.toolItems.get(parentRoot);
    if (!parent || parent.role !== 'tool') { return; }
    const existingChildren = parent.children ?? [];
    const at = existingChildren.findIndex((c) => c.id === item.id);
    const children = at >= 0
      ? existingChildren.map((c, i) => (i === at ? item : c))
      : [...existingChildren, item];
    const settledParent: TranscriptItem = { ...parent, children };
    this.toolItems.set(parentRoot, settledParent);
    this.replaceItem(settledParent);
  }

  /**
   * Settles every tool call still running when the turn ended.
   *
   * A turn that ends is a turn where nothing more is coming, so a call still
   * at 'running' is a call whose `tool-end` never arrived — interrupt,
   * provider crash, or a notification the adapter did not recognize.
   * Measured against codex-cli 0.147.0, where a dropped `item/completed`
   * left the card spinning "Running…" with the status dot already back to
   * idle, and nothing but a reload to clear it. For a parent it also flushes
   * its buffered children, which would otherwise be dropped on the floor —
   * discarding, on disk, subagent work the user watched happen on screen.
   *
   * Children settle first so a parent's copy of them is the settled one.
   */
  private flushUnsettledTools(): void {
    for (const [toolId, item] of this.toolItems) {
      const parentRoot = this.childOf.get(toolId);
      if (!parentRoot || item.role !== 'tool' || item.state !== 'running') { continue; }
      const settled = unsettled(item);
      this.toolItems.set(toolId, settled);
      this.replaceChild(parentRoot, settled);
    }

    for (const [toolId, item] of this.toolItems) {
      if (this.childOf.has(toolId) || item.role !== 'tool' || item.state !== 'running') { continue; }
      const children = this.childrenByParent.get(toolId);
      const settled: TranscriptItem = {
        ...unsettled(item),
        ...(children ? { children: [...children] } : {}),
      };
      this.toolItems.set(toolId, settled);
      this.replaceItem(settled);
    }
    this.childrenByParent.clear();
  }

  private pendingAssistant: { text?: string; thinking?: string } | undefined;

  /** Accumulates streamed deltas into the open assistant item. */
  private mergeDelta(itemId: string, field: 'text' | 'thinking', delta: string): void {
    const current = this.pendingAssistant ?? {};
    current[field] = (current[field] ?? '') + delta;
    this.pendingAssistant = current;
    this.store.replace(this._state.id, {
      id: itemId, ts: Date.now(), role: 'assistant',
      text: current.text ?? '', thinking: current.thinking,
    });
    this._state.updatedAt = Date.now();
    this.sink.patch(this._state.id, { op: 'delta', itemId, field, delta });
  }

  /** Ends the current assistant item so the next delta starts a new one. */
  private closeAssistant(): void {
    this.openAssistantId = undefined;
    this.pendingAssistant = undefined;
  }

  private setStatus(status: SessionStatus): void {
    if (this._state.status === status) { return; }
    this._state.status = status;
    this._state.updatedAt = Date.now();
    this.sink.status(this._state.id, status);
    this.sink.changed();
  }
}
