import { formatEditorContext } from '../format-editor-context';
import type {
  AgentEvent, AgentRun, ContextBreakdown, EditorContext,
  EffortLevel, PermissionMode, StartOptions, ToolDecision, UsageWindow,
} from '../types';
import type { AppServer, RequestId } from './app-server';
import { approvalEventOf, DECLINED_INPUT_METHODS, mapNotification } from './map-events';
import { codexSettings, sandboxPolicyOf } from './map-settings';
import { toContextBreakdown, toUsageWindows } from './map-usage';
import type { RateLimitSnapshot, ReviewDecision, ThreadTokenUsage } from './wire';

/** Same async-iterable pattern as `FakeProvider`'s — the house idiom for an `AgentRun.events`. */
class EventChannel implements AsyncIterable<AgentEvent> {
  private queue: AgentEvent[] = [];
  private waiting: ((v: IteratorResult<AgentEvent>) => void) | undefined;
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) { return; }
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: (): Promise<IteratorResult<AgentEvent>> => {
        const next = this.queue.shift();
        if (next) { return Promise.resolve({ value: next, done: false }); }
        if (this.closed) { return Promise.resolve({ value: undefined as never, done: true }); }
        return new Promise((resolve) => { this.waiting = resolve; });
      },
    };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One Codex thread, presented as an `AgentRun`.
 *
 * Thread creation is lazy — deferred to the first `send()` — for the same
 * reason the Claude provider defers query construction: a session restored on
 * a reload should not spawn backend work until the user actually uses it, and
 * the settings a thread starts with can still change before then.
 *
 * The connection is shared with every other Codex session, so this class
 * filters by `threadId` on the way in and tags by it on the way out. A run
 * that has not started yet has no id, and drops everything.
 */
export class CodexRun implements AgentRun {
  readonly events = new EventChannel();

  private _threadId: string | undefined;
  /** Public getter, no setter — the `readonly` half of the interface's promise. */
  get threadId(): string | undefined { return this._threadId; }

  /**
   * Resolves once the id is known, however it becomes known — a
   * `thread/start`/`thread/resume` response that already carries it, or the
   * `thread/started` notification when it does not. `send()`'s `turn/start`
   * awaits this rather than reading `_threadId` synchronously, since the two
   * sources can race.
   */
  private resolveThreadId!: (id: string | undefined) => void;
  private readonly threadIdReady = new Promise<string | undefined>((resolve) => {
    this.resolveThreadId = resolve;
  });

  /** Mutable, live settings — what `send()` starts with, and what a setter retargets. */
  private mode: PermissionMode;
  private model: string | undefined;
  private effort: EffortLevel | undefined;

  /** Set once `send()` has been called; guards against starting a thread twice. */
  private startPromise: Promise<string | undefined> | undefined;
  private disposed = false;

  /** JSON-RPC id (as received) for every outstanding `permission` event, keyed by its string id. */
  private readonly pendingApprovals = new Map<string, RequestId>();

  /**
   * The last-known context occupancy. `contextBreakdown` (below) is attached
   * to this instance only once a `thread/tokenUsage/updated` report with a
   * usable `modelContextWindow` has arrived — never resolved from nothing.
   * `AgentSession` treats the method's mere presence as "this provider
   * reports context usage", so leaving it unset until there is a real
   * breakdown is what keeps that promise honest. See the `FakeProvider`
   * precedent, which attaches the same method conditionally for the same
   * reason.
   */
  private lastContextBreakdown: ContextBreakdown | undefined;
  contextBreakdown?: () => Promise<ContextBreakdown>;

  constructor(private readonly server: AppServer, private readonly opts: StartOptions) {
    this.mode = opts.permissionMode;
    this.model = opts.model;
    this.effort = opts.effort;

    server.onNotification((method, params) => {
      const p = (params ?? {}) as { threadId?: string };
      // `thread/started` is the one notification allowed through before (or
      // regardless of) this run's own id, since it is what establishes that
      // id in the first place. Everything else is dropped once it names a
      // thread that is not this one — including "no id yet", since a run
      // that has not started has nothing to match against.
      if (method !== 'thread/started' && p.threadId !== this._threadId) { return; }

      if (method === 'thread/started') {
        const id = (params as { thread?: { id?: string } } | undefined)?.thread?.id;
        this.setThreadId(id);
      }
      if (method === 'thread/tokenUsage/updated') {
        this.captureContextUsage((params as { tokenUsage?: ThreadTokenUsage } | undefined)?.tokenUsage);
      }
      for (const event of mapNotification(method, params)) { this.events.push(event); }
    });

    server.onServerRequest((method, id, params) => {
      const p = (params ?? {}) as { threadId?: string };
      if (p.threadId !== undefined && p.threadId !== this._threadId) { return; }

      if (DECLINED_INPUT_METHODS.includes(method)) {
        // v1 cannot render a typed-input request, but an unanswered blocking
        // one hangs the turn — so it is declined immediately, and the
        // transcript says so rather than failing silently.
        const toolId = String(id);
        this.events.push({ kind: 'tool-start', id: toolId, name: method, input: params });
        this.events.push({
          kind: 'tool-end', id: toolId, ok: false,
          output: 'The panel cannot answer this request yet.',
        });
        this.server.respond(id, {});
        return;
      }

      const approval = approvalEventOf(method, id, params);
      if (approval && approval.kind === 'permission') {
        this.pendingApprovals.set(approval.id, id);
        this.events.push(approval);
      }
    });

    server.onClose((reason) => {
      this.events.push({ kind: 'turn-end', reason: 'error', error: reason });
      this.events.close();
    });
  }

  private setThreadId(id: string | undefined): void {
    if (!id || this._threadId) { return; }
    this._threadId = id;
    this.resolveThreadId(id);
  }

  /**
   * Records the latest token-usage report and, the first time one arrives
   * with a real context window, attaches `contextBreakdown` — see that
   * field's comment for why this is conditional rather than always present.
   */
  private captureContextUsage(usage: ThreadTokenUsage | undefined): void {
    if (!usage) { return; }
    const breakdown = toContextBreakdown(usage);
    if (!breakdown) { return; }
    this.lastContextBreakdown = breakdown;
    if (!this.contextBreakdown) {
      this.contextBreakdown = async (): Promise<ContextBreakdown> => {
        // Non-null by construction: this closure only exists once
        // lastContextBreakdown has been assigned at least once, above, and
        // nothing ever clears it back to undefined.
        return this.lastContextBreakdown as ContextBreakdown;
      };
    }
  }

  /**
   * Starts (or resumes) the thread exactly once, on the first `send()`.
   * Never called from `interrupt()`/the setters/`dispose()` — none of those
   * should be the thing that spawns backend work for a session nobody has
   * used.
   */
  private ensureStarted(): Promise<string | undefined> {
    if (!this.startPromise) { this.startPromise = this.startThread(); }
    return this.startPromise;
  }

  private async startThread(): Promise<string | undefined> {
    const settings = codexSettings(this.mode);
    const base = {
      ...settings,
      cwd: this.opts.cwd,
      model: this.model,
      effort: this.effort,
    };
    try {
      const result = this.opts.resumeToken
        ? await this.server.request<{ threadId?: string }>(
          'thread/resume', { threadId: this.opts.resumeToken, ...base },
        )
        : await this.server.request<{ threadId?: string }>('thread/start', base);
      this.setThreadId(result?.threadId);
      // Already resolved if the response (or a race-won notification) carried
      // the id above; otherwise this waits for `thread/started`.
      return await this.threadIdReady;
    } catch (err) {
      this.events.push({ kind: 'turn-end', reason: 'error', error: errorMessage(err) });
      return undefined;
    }
  }

  send(text: string, context?: EditorContext): void {
    // One text block rather than two, same as the Claude provider: a single
    // block keeps the turn's shape identical whether or not context is
    // attached.
    const body = context ? `${formatEditorContext(context)}\n\n${text}` : text;
    this.ensureStarted().then((threadId) => {
      if (this.disposed || !threadId) { return; }
      this.server.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: body, text_elements: [] }],
      }).catch((err: unknown) => {
        this.events.push({ kind: 'turn-end', reason: 'error', error: errorMessage(err) });
      });
      // ensureStarted() never rejects (its own catch above turns a failure
      // into a turn-end event and resolves with undefined), so this .then
      // needs no paired .catch.
    });
  }

  respondToTool(id: string, decision: ToolDecision): void {
    const rpcId = this.pendingApprovals.get(id);
    if (rpcId === undefined) { return; }
    this.pendingApprovals.delete(id);
    const result: ReviewDecision = decision.allow
      ? 'approved'
      : { denied: { rejection: decision.reason ?? 'Denied from the panel' } };
    this.server.respond(rpcId, { decision: result });
  }

  /**
   * Fire-and-forget by design, like `setModel`/`setEffort` below: callers
   * must never see this reject. Before the first `send()`, `this.mode` above
   * is all there is — it is what `startThread()` reads when it eventually
   * runs. After, the live thread is retargeted via `thread/metadata/update`,
   * carrying both settings shapes Codex actually reads: `sandbox` at
   * `thread/start` time is the bare `SandboxMode` enum, but a live update
   * (like `turn/start`) takes the `SandboxPolicy` struct — see
   * `sandboxPolicyOf`'s own comment.
   */
  setPermissionMode(mode: PermissionMode): void {
    this.mode = mode;
    if (!this._threadId) { return; }
    const settings = codexSettings(mode);
    try {
      this.server.request('thread/metadata/update', {
        threadId: this._threadId,
        approvalPolicy: settings.approvalPolicy,
        sandboxPolicy: sandboxPolicyOf(mode),
        approvalsReviewer: settings.approvalsReviewer,
      }).catch((err: unknown) => {
        console.warn('[hiiiid-code] codex setPermissionMode rejected', 'mode=', mode, 'reason=', errorMessage(err));
      });
    } catch (err) {
      // A synchronous throw (e.g. the connection is already torn down) is
      // exactly as non-fatal as the async rejection above.
      console.warn('[hiiiid-code] codex setPermissionMode threw', 'mode=', mode, 'error=', errorMessage(err));
    }
  }

  /** Same fire-and-forget contract as `setPermissionMode`. */
  setModel(model: string): void {
    this.model = model;
    if (!this._threadId) { return; }
    try {
      this.server.request('thread/metadata/update', { threadId: this._threadId, model })
        .catch((err: unknown) => {
          console.warn('[hiiiid-code] codex setModel rejected', 'model=', model, 'reason=', errorMessage(err));
        });
    } catch (err) {
      console.warn('[hiiiid-code] codex setModel threw', 'model=', model, 'error=', errorMessage(err));
    }
  }

  /** Same fire-and-forget contract as `setPermissionMode`. */
  setEffort(effort: EffortLevel): void {
    this.effort = effort;
    if (!this._threadId) { return; }
    try {
      this.server.request('thread/metadata/update', { threadId: this._threadId, effort })
        .catch((err: unknown) => {
          console.warn('[hiiiid-code] codex setEffort rejected', 'effort=', effort, 'reason=', errorMessage(err));
        });
    } catch (err) {
      console.warn('[hiiiid-code] codex setEffort threw', 'effort=', effort, 'error=', errorMessage(err));
    }
  }

  async interrupt(): Promise<void> {
    if (this._threadId) {
      try {
        await this.server.request('turn/interrupt', { threadId: this._threadId });
      } catch {
        // Best-effort: whether or not Codex could act on it, the user's
        // intent was to stop, so the turn ends here either way.
      }
    }
    this.events.push({ kind: 'turn-end', reason: 'interrupted' });
  }

  /**
   * Account/plan usage on this run's live connection — a process-global
   * request, so it needs no thread and works even before the first `send()`.
   */
  async usageWindows(): Promise<UsageWindow[] | undefined> {
    if (this.disposed) { return undefined; }
    try {
      const snapshot = await this.server.request<RateLimitSnapshot>('account/rateLimits/read', {});
      return toUsageWindows(snapshot);
    } catch {
      return undefined;
    }
  }

  /** Best-effort — the connection may already be gone. */
  async dispose(): Promise<void> {
    if (this.disposed) { return; }
    this.disposed = true;
    // Left-over approvals get an explicit denial rather than hanging forever
    // on a session that is going away.
    for (const [, rpcId] of this.pendingApprovals) {
      this.server.respond(rpcId, { decision: { denied: { rejection: 'Session closed' } } });
    }
    this.pendingApprovals.clear();
    if (this._threadId) {
      try {
        await this.server.request('thread/unsubscribe', { threadId: this._threadId });
      } catch {
        // Best-effort: the connection may already be gone.
      }
    }
    this.events.close();
  }
}
