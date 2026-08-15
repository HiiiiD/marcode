import { formatEditorContext } from '../format-editor-context';
import type {
  AgentEvent, AgentRun, ContextBreakdown, EditorContext, EffortLevel, McpServerStatus,
  PermissionMode, StartOptions, ToolDecision, UsageWindow,
} from '../types';
import type { RequestId } from './app-server';
import { approvalEventOf, DECLINED_INPUT_METHODS, mapNotification } from './map-events';
import { codexSettings, sandboxPolicyOf } from './map-settings';
import { toInvocables } from './map-skills';
import { toContextBreakdown, toUsageWindows } from './map-usage';
import type {
  FileChangeApprovalDecision, McpServerElicitationRequestResponse,
  PermissionsRequestApprovalResponse, RateLimitsReadResponse, SkillsListResponse,
  ThreadTokenUsage, ToolRequestUserInputResponse,
} from './wire';

/**
 * The subset of `AppServer` this class needs.
 *
 * `AppServer`'s `onNotification`/`onServerRequest`/`onClose` are single-slot
 * setters — last caller wins — and one process (one `AppServer`) serves every
 * Codex session. Passing the literal `AppServer` to two `CodexRun`s would let
 * the second registration steal the first run's callbacks. `CodexProvider`
 * fixes this by handing each run a private view onto the shared connection
 * (see codex-provider.ts) instead of the connection itself: `request`/
 * `respond` pass straight through, while the three `on*` setters are local to
 * the view, and the provider broadcasts every incoming frame to every live
 * view. Widening this type from `AppServer` to this duck-typed interface is
 * what makes that possible — a real `AppServer` still satisfies it
 * structurally, so passing one directly (as every existing test here does)
 * keeps working unchanged.
 */
export interface CodexConnection {
  request<T>(method: string, params: unknown): Promise<T>;
  respond(id: RequestId, result: unknown): void;
  onNotification(cb: (method: string, params: unknown) => void): void;
  onServerRequest(cb: (method: string, id: RequestId, params: unknown) => void): void;
  onClose(cb: (reason: string) => void): void;
}

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

  /**
   * Set by `onClose` — the connection this run was started on is gone.
   *
   * Distinct from `disposed`, and load-bearing: `setBinPath` tears the shared
   * process down unconditionally, without disposing the runs on it. A run
   * that kept issuing requests afterwards would go through
   * `ThreadView.request`, which calls `connection()` and so SPAWNS A FRESH
   * PROCESS — then drives it with a thread id that only existed in the dead
   * one, and pushes every resulting error into an already-closed channel
   * where nobody can see it. `dead` is the guard on every outbound path.
   */
  private connectionClosed = false;

  /** No request may leave this run once either of these is true. */
  private get dead(): boolean { return this.disposed || this.connectionClosed; }

  /**
   * Every outstanding `permission` event, keyed by its string id.
   *
   * The originating `method` is kept alongside the JSON-RPC id because the
   * three approval requests take three *different* response shapes — see
   * `respondToTool`. Answering a fileChange request with a command decision
   * (or either with the legacy v1 `ReviewDecision`) is silently rejected by
   * the server and the tool never runs.
   */
  private readonly pendingApprovals = new Map<string, { rpcId: RequestId; method: string }>();

  /**
   * Every MCP server this thread has heard a startup status for, by name.
   *
   * `mcpServer/startupStatus/updated` reports one server at a time, while the
   * `mcp-servers` event is a full-replacement list (`AgentSession` assigns it
   * wholesale). Emitting a single-element list per notification would leave
   * the strip showing only whichever server reported last.
   */
  private readonly mcpServers = new Map<string, McpServerStatus>();

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

  constructor(
    private readonly server: CodexConnection,
    private readonly opts: StartOptions,
    /**
     * Fired once, at the end of `dispose()` — never earlier, so the provider
     * only sees this run as gone once its own cleanup (declining pending
     * approvals, unsubscribing, closing `events`) has actually happened.
     * This is `CodexProvider`'s ref-counting hook: it drops this run's view
     * and tears the shared process down once nothing is left using it.
     * Optional and unused by every existing caller/test, which construct
     * `CodexRun` directly against a single-run connection.
     */
    private readonly onDispose?: () => void,
  ) {
    this.mode = opts.permissionMode;
    this.model = opts.model;
    this.effort = opts.effort;

    server.onNotification((method, params) => {
      const p = (params ?? {}) as { threadId?: string };
      // A notification that names no thread at all (e.g.
      // `account/rateLimits/updated`) is process-global, not thread-scoped —
      // it must pass through regardless of whether this run has started.
      // `thread/started` is the one *thread-scoped* notification let through
      // even when it names a thread other than this run's current one, since
      // it is what establishes that id in the first place. Everything else
      // naming a different thread is dropped. Mirrors the identical guard on
      // `onServerRequest` below.
      if (method !== 'thread/started' && p.threadId !== undefined && p.threadId !== this._threadId) { return; }

      if (method === 'thread/started') {
        const id = (params as { thread?: { id?: string } } | undefined)?.thread?.id;
        this.setThreadId(id);
      }
      if (method === 'thread/tokenUsage/updated') {
        this.captureContextUsage((params as { tokenUsage?: ThreadTokenUsage } | undefined)?.tokenUsage);
      }
      if (method === 'skills/changed') {
        // A pure invalidation signal — `SkillsChangedNotification` is
        // `Record<string, never>`, i.e. an empty object, so there is nothing
        // for a mapper to map. The refreshed list has to be pulled.
        void this.refreshInvocables();
      }
      for (const event of mapNotification(method, params)) {
        this.events.push(event.kind === 'mcp-servers' ? this.mergeMcpServers(event.servers) : event);
      }
    });

    server.onServerRequest((method, id, params) => {
      const p = (params ?? {}) as { threadId?: string };
      if (p.threadId !== undefined && p.threadId !== this._threadId) { return; }

      if (DECLINED_INPUT_METHODS.includes(method)) {
        // Each of these has its own required-field response shape — `{}`
        // fails deserialization server-side, which leaves the blocking
        // request unanswered and hangs the turn, i.e. exactly what this
        // branch exists to prevent.
        const refusal: ToolRequestUserInputResponse | McpServerElicitationRequestResponse
          = method === 'item/tool/requestUserInput'
            // A map, so an empty one is structurally valid and says
            // "answered none of the questions".
            ? { answers: {} }
            : { action: 'decline', content: null, _meta: null };
        // v1 cannot render a typed-input request, but an unanswered blocking
        // one hangs the turn — so it is declined immediately, and the
        // transcript says so rather than failing silently.
        const toolId = String(id);
        this.events.push({ kind: 'tool-start', id: toolId, name: method, input: params });
        this.events.push({
          kind: 'tool-end', id: toolId, ok: false,
          output: 'The panel cannot answer this request yet.',
        });
        this.server.respond(id, refusal);
        return;
      }

      const approval = approvalEventOf(method, id, params);
      if (approval && approval.kind === 'permission') {
        this.pendingApprovals.set(approval.id, { rpcId: id, method });
        this.events.push(approval);
      }
    });

    server.onClose((reason) => {
      this.connectionClosed = true;
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
    // No `effort` here: neither `ThreadStartParams` nor `ThreadResumeParams`
    // declares one (verified against the codex-cli 0.147.0 bindings). serde
    // ignores unknown fields, so sending it was inert rather than fatal —
    // which is exactly why it had to go: a field that looks like it works and
    // does nothing is worse than no field. Effort reaches the model on the
    // first `turn/start`, which does declare it (see `send`).
    const base = {
      ...settings,
      cwd: this.opts.cwd,
      model: this.model,
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
      if (this.dead || !threadId) { return; }
      const settings = codexSettings(this.mode);
      this.server.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: body, text_elements: [] }],
        // Codex has no in-place "patch the live thread" request —
        // `ThreadMetadataUpdateParams` carries only `threadId` and
        // `gitInfo`, nothing settings-shaped. Every field below is
        // documented on `TurnStartParams` as "Override … for this turn and
        // subsequent turns", which is Codex's actual live-retarget
        // primitive: the *next* turn is where a `setPermissionMode` /
        // `setModel` / `setEffort` call (below) actually takes effect, read
        // fresh off `this.mode`/`this.model`/`this.effort` every time. A
        // turn already in flight keeps whatever `turn/start` it was sent
        // with — Codex, not this class, is what makes that true.
        approvalPolicy: settings.approvalPolicy,
        approvalsReviewer: settings.approvalsReviewer,
        sandboxPolicy: sandboxPolicyOf(this.mode),
        model: this.model,
        effort: this.effort,
      }).catch((err: unknown) => {
        this.events.push({ kind: 'turn-end', reason: 'error', error: errorMessage(err) });
      });
      // ensureStarted() never rejects (its own catch above turns a failure
      // into a turn-end event and resolves with undefined), so this .then
      // needs no paired .catch.
    });
  }

  /**
   * Answers one parked approval in the shape its own request declared.
   *
   * The three `item/*\/requestApproval` requests do NOT share a response
   * type, which is why `pendingApprovals` remembers the method:
   *
   * - `commandExecution` and `fileChange` each take `{ decision }`, from
   *   their own v2 enum. Both spell yes/no `accept`/`decline` — NOT the
   *   legacy v1 `'approved'`/`{denied:{rejection}}`, which belongs to the
   *   `execCommandApproval`/`applyPatchApproval` requests this client never
   *   uses. Measured live on codex-cli 0.147.0: `{decision:'approved'}` left
   *   the command unrun and the agent reported that its "required approval
   *   mechanism failed"; `{decision:'accept'}` ran it.
   * - `permissions` has no `decision` field at all — it asks which extra
   *   permissions to grant and for how long, not yes/no. There is no
   *   `decline` member to send. The nearest honest refusal the type can
   *   express is an EMPTY grant (both fields of `GrantedPermissionProfile`
   *   are optional) at the narrower `'turn'` scope: grant nothing, for this
   *   turn only. That is what a denial means, and it is also what an
   *   "allow" from our card would have to send, since a `ToolDecision`
   *   carries no permission set to widen with — so the answer is the same
   *   either way and the card cannot actually grant anything. Rendering a
   *   real grant UI is the fix; guessing a payload is not.
   *
   * `decision.reason` has nowhere to go in any of these — no v2 decision
   * carries free text. It stays in the transcript, where the user wrote it.
   */
  respondToTool(id: string, decision: ToolDecision): void {
    const pending = this.pendingApprovals.get(id);
    if (!pending) { return; }
    this.pendingApprovals.delete(id);
    if (pending.method === 'item/permissions/requestApproval') {
      const result: PermissionsRequestApprovalResponse = { permissions: {}, scope: 'turn' };
      this.server.respond(pending.rpcId, result);
      return;
    }
    // One shared spelling across both remaining methods — the two enums
    // agree on these members — but typed against the narrower of the two so
    // a future divergence fails here rather than on the wire.
    const result: FileChangeApprovalDecision = decision.allow ? 'accept' : 'decline';
    this.server.respond(pending.rpcId, { decision: result });
  }

  /**
   * Folds one server's status into the roster and returns the whole of it.
   *
   * See `mcpServers` for why: the notification is per-server, the event is a
   * full replacement.
   */
  private mergeMcpServers(servers: McpServerStatus[]): AgentEvent {
    for (const server of servers) { this.mcpServers.set(server.name, server); }
    return { kind: 'mcp-servers', servers: [...this.mcpServers.values()] };
  }

  /**
   * Re-pulls the skill catalog after a `skills/changed` invalidation.
   *
   * Never rejects: a failed refresh leaves the `/`-menu showing the last
   * list that worked, which is strictly better than emptying it. Guarded on
   * `disposed` for the same reason `usageWindows` is — see there.
   */
  private async refreshInvocables(): Promise<void> {
    if (this.dead) { return; }
    try {
      const response = await this.server.request<SkillsListResponse>(
        'skills/list', { cwds: [this.opts.cwd] },
      );
      if (this.dead) { return; }
      this.events.push({ kind: 'invocables', entries: toInvocables(response) });
    } catch {
      // Best-effort, as above.
    }
  }

  /**
   * `void`-returning, like `setModel`/`setEffort` below — but unlike the
   * Claude provider's setters, this one has no separate live-retarget
   * request to fire and nothing that can reject: Codex has no in-place patch
   * for a thread's settings (`ThreadMetadataUpdateParams` carries only
   * `threadId` and `gitInfo` — verified against the generated bindings for
   * codex-cli 0.147.0; there is no `thread/settings/update` request,
   * `thread/settings/updated` is a server→client notification). Recording
   * the new mode here is the entire effect: `send()` reads `this.mode` fresh
   * on every `turn/start`, which is Codex's actual live-override primitive
   * (`TurnStartParams`' settings fields are each documented "Override … for
   * this turn and subsequent turns"). A turn already in flight finishes on
   * what it started with; the next `send()` picks this up.
   */
  setPermissionMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** Same contract as `setPermissionMode` — recorded, applied on the next `turn/start`. */
  setModel(model: string): void {
    this.model = model;
  }

  /** Same contract as `setPermissionMode` — recorded, applied on the next `turn/start`. */
  setEffort(effort: EffortLevel): void {
    this.effort = effort;
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
    // `dead`, not `disposed`: a run whose connection was torn down by
    // `setBinPath` would otherwise respawn a process just to ask this. See
    // `connectionClosed`.
    if (this.dead) { return undefined; }
    try {
      // The snapshot is NESTED under `rateLimits` (`GetAccountRateLimitsResponse`),
      // not returned bare — reading it as a `RateLimitSnapshot` finds no
      // `primary`/`secondary` and silently yields an empty strip. Params are
      // `{}`: the request declares a serde unit, and `{ cwd }` is a hard
      // protocol error.
      const response = await this.server.request<RateLimitsReadResponse>(
        'account/rateLimits/read', {},
      );
      return toUsageWindows(response?.rateLimits);
    } catch {
      return undefined;
    }
  }

  /** Best-effort — the connection may already be gone. */
  async dispose(): Promise<void> {
    if (this.disposed) { return; }
    this.disposed = true;
    // Left-over approvals get an explicit denial rather than hanging forever
    // on a session that is going away — in each request's own response shape,
    // same as `respondToTool`. A v1 `{denied:{rejection}}` here is not a
    // denial at all: it fails to deserialize and the request stays parked.
    for (const [, pending] of this.pendingApprovals) {
      if (pending.method === 'item/permissions/requestApproval') {
        const empty: PermissionsRequestApprovalResponse = { permissions: {}, scope: 'turn' };
        this.server.respond(pending.rpcId, empty);
      } else {
        const declined: FileChangeApprovalDecision = 'decline';
        this.server.respond(pending.rpcId, { decision: declined });
      }
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
    this.onDispose?.();
  }
}
