import { attachmentLines, imageAttachments } from '../attachment-payload';
import { formatEditorContext } from '../format-editor-context';
import type {
  AgentEvent, AgentRun, Attachment, ContextBreakdown, EditorContext, EffortLevel, McpServerStatus,
  PermissionMode, QuestionAnswers, StartOptions, ToolDecision, UsageWindow,
} from '../types';
import type { RequestId } from './app-server';
import { approvalEventOf, DECLINED_INPUT_METHODS, mapNotification, questionEventOf } from './map-events';
import { codexSettings, sandboxPolicyOf } from './map-settings';
import { toInvocables } from './map-skills';
import { toContextBreakdown, toUsageWindows } from './map-usage';
import type {
  FileChangeApprovalDecision, McpServerElicitationRequestResponse,
  PermissionsRequestApprovalResponse, RateLimitsReadResponse, SkillsListResponse,
  ThreadResponse, ThreadTokenUsage, ToolRequestUserInputResponse, UserInput,
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
 * The thread id a notification names, or `undefined` for a process-global
 * one (e.g. `account/rateLimits/updated`) that carries no thread at all.
 *
 * `thread/started` needs its own reading because it names its thread under
 * `thread.id` rather than `threadId` — the generic lookup finds nothing
 * there, which used to let a stranger's start reach every run and overwrite
 * its resume token with a thread it had never talked to.
 */
function threadIdOf(method: string, params: unknown): string | undefined {
  const p = (params ?? {}) as { threadId?: string; thread?: { id?: string } };
  return method === 'thread/started' ? p.thread?.id : p.threadId;
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

  /** Every outstanding `question` event, keyed by its string id -> the JSON-RPC request id it must answer. */
  private readonly pendingQuestions = new Map<string, RequestId>();

  /**
   * Every subagent thread this run has rejoined, keyed by the child's own
   * `agentThreadId` -> the id of the `subAgentActivity` tool card its
   * activity nests under (the same id `AgentSession` uses as `parentId` to
   * park a child transcript item under its parent — see `agent-session.ts`).
   *
   * Codex reports a spawned subagent as a genuinely separate thread — its
   * commands and file edits arrive as notifications addressed to *that*
   * thread's own id, not this run's `_threadId` — so nesting them the way
   * Claude's `Task` calls nest (which share one event stream with the caller)
   * needs two things this map exists to hold together: `thread/resume`
   * against the child's id to start receiving its notifications at all (see
   * `rejoinSubagentThread`), and this id to stamp every one of them with the
   * `parentId` that puts them under the right card.
   */
  private readonly childThreads = new Map<string, string>();

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
      const named = threadIdOf(method, params);
      const fromChild = named !== undefined && named !== this._threadId
        ? this.childThreads.get(named) : undefined;

      // A notification that names no thread at all (e.g.
      // `account/rateLimits/updated`) is process-global, not thread-scoped —
      // it must pass through regardless of whether this run has started.
      // Anything naming a thread that is neither this one nor a rejoined
      // subagent's is dropped. Mirrors the identical guard on
      // `onServerRequest` below.
      if (named !== undefined && named !== this._threadId && fromChild === undefined) { return; }

      if (fromChild !== undefined) {
        // A subagent's own thread — only its tool lifecycle nests under the
        // spawn card; its `turn/completed`, usage, and text deltas are that
        // thread's business, not this run's turn. `mapNotification` still
        // does the item -> `ToolCall` translation; only `parentId` and the
        // event-kind filter are specific to a child's traffic.
        for (const event of mapNotification(method, params)) {
          if (event.kind === 'tool-start' || event.kind === 'tool-end') {
            this.events.push({ ...event, parentId: fromChild });
          }
        }
        return;
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
        if (event.kind === 'tool-start' && event.tool.kind === 'subagent' && event.tool.action === 'spawn') {
          const agentThreadId = event.tool.target;
          if (agentThreadId) {
            this.childThreads.set(agentThreadId, event.id);
            void this.rejoinSubagentThread(agentThreadId);
          }
        }
        if (event.kind === 'tool-end' && event.tool?.kind === 'subagent' && event.tool.action === 'collect') {
          const agentThreadId = event.tool.target;
          if (agentThreadId) { void this.leaveSubagentThread(agentThreadId); }
        }
        this.events.push(event.kind === 'mcp-servers' ? this.mergeMcpServers(event.servers) : event);
      }
    });

    server.onServerRequest((method, id, params) => {
      const p = (params ?? {}) as { threadId?: string };
      const fromChild = p.threadId !== undefined && p.threadId !== this._threadId
        ? this.childThreads.get(p.threadId) : undefined;
      if (p.threadId !== undefined && p.threadId !== this._threadId && fromChild === undefined) { return; }

      if (method === 'item/tool/requestUserInput') {
        const event = questionEventOf(id, params);
        if (event) {
          this.pendingQuestions.set(event.id, id);
          this.events.push(fromChild ? { ...event, parentId: fromChild } : event);
          return;
        }
        // Params we cannot read. The request is still blocking, so it must be
        // answered or the turn hangs with no card to answer it — `{answers:{}}`
        // is the structurally-valid "answered nothing" (a bare `{}` fails
        // deserialization server-side; see wire.ts). The transcript says so,
        // the same way the elicitation decline below does, rather than the
        // mapper throwing out of this listener.
        const toolId = String(id);
        this.events.push({
          kind: 'tool-start', id: toolId,
          tool: { kind: 'other', label: method, raw: params },
          ...(fromChild ? { parentId: fromChild } : {}),
        });
        this.events.push({
          kind: 'tool-end', id: toolId, ok: false,
          output: { kind: 'text', text: 'The panel could not read this request.' },
          ...(fromChild ? { parentId: fromChild } : {}),
        });
        this.server.respond(id, { answers: {} } satisfies ToolRequestUserInputResponse);
        return;
      }

      if (DECLINED_INPUT_METHODS.includes(method)) {
        // MCP elicitation has its own required-field response shape — `{}`
        // fails deserialization server-side, which leaves the blocking
        // request unanswered and hangs the turn, i.e. exactly what this
        // branch exists to prevent.
        const refusal: McpServerElicitationRequestResponse
          = { action: 'decline', content: null, _meta: null };
        // Elicitation is deliberately unmodelled, but an unanswered blocking
        // request hangs the turn — so it is declined immediately, and the
        // transcript says so rather than failing silently.
        const toolId = String(id);
        this.events.push({
          kind: 'tool-start', id: toolId,
          tool: { kind: 'other', label: method, raw: params },
          ...(fromChild ? { parentId: fromChild } : {}),
        });
        this.events.push({
          kind: 'tool-end', id: toolId, ok: false,
          output: { kind: 'text', text: 'The panel cannot answer this request yet.' },
          ...(fromChild ? { parentId: fromChild } : {}),
        });
        this.server.respond(id, refusal);
        return;
      }

      const approval = approvalEventOf(method, id, params);
      if (approval && approval.kind === 'permission') {
        this.pendingApprovals.set(approval.id, { rpcId: id, method });
        this.events.push(fromChild ? { ...approval, parentId: fromChild } : approval);
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
  }

  /**
   * Rejoins a subagent's own thread so its notifications start arriving on
   * this same connection — Codex does not push a thread's traffic to a
   * client that never subscribed to it. `ThreadResumeParams.threadId` is the
   * only field sent: every override it carries (model, cwd, sandbox, …) is
   * optional and documented as retargeting the thread, which a subagent we
   * merely want to *watch* must not do. Per its own doc comment, resuming a
   * thread that is already running "rejoins" it rather than replaying it.
   * Best-effort: a failed rejoin leaves the spawn card visible but flat,
   * which is what this run already showed before this feature existed.
   */
  private async rejoinSubagentThread(agentThreadId: string): Promise<void> {
    if (this.dead) { return; }
    try {
      await this.server.request('thread/resume', { threadId: agentThreadId });
    } catch {
      // Best-effort, as above.
    }
  }

  /**
   * Stops tracking a subagent thread and releases the rejoin from
   * `rejoinSubagentThread` — the same cleanup `dispose()` does for this
   * run's own thread, mirrored for a child's. Called once its
   * `subAgentActivity` reports `'interrupted'`, and again (for every thread
   * still tracked) from `dispose()`.
   */
  private async leaveSubagentThread(agentThreadId: string): Promise<void> {
    this.childThreads.delete(agentThreadId);
    if (this.dead) { return; }
    try {
      await this.server.request('thread/unsubscribe', { threadId: agentThreadId });
    } catch {
      // Best-effort, as above.
    }
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
      // Both requests answer with the whole `Thread` under `thread` — there
      // is no bare `threadId` on either response (measured on codex-cli
      // 0.147.0). Reading one found `undefined`, and the id then had to come
      // from the `thread/started` notification, which `thread/start` emits
      // and `thread/resume` DOES NOT: every resumed session waited forever
      // for a notification that was never coming, never sent its
      // `turn/start`, and showed "Working…" with no error and no way out.
      // The response is now the single source, so both paths behave the same.
      const result = this.opts.resumeToken
        ? await this.server.request<ThreadResponse>(
          'thread/resume', { threadId: this.opts.resumeToken, ...base },
        )
        : await this.server.request<ThreadResponse>('thread/start', base);
      const id = result?.thread?.id;
      if (!id) { throw new Error('Codex started a thread without an id.'); }
      this.setThreadId(id);
      // Emitted here rather than left to `thread/started` for the same
      // reason: a resumed thread never gets that notification, and a session
      // whose resume token is never recorded is one that starts from nothing
      // after the next reload.
      this.events.push({ kind: 'session', resumeToken: id });
      return this._threadId;
    } catch (err) {
      this.events.push({ kind: 'turn-end', reason: 'error', error: errorMessage(err) });
      return undefined;
    }
  }

  send(text: string, context?: EditorContext, attachments?: Attachment[]): void {
    const body = context ? `${formatEditorContext(context)}\n\n${text}` : text;
    const input: UserInput[] = [
      { type: 'text', text: `${body}${attachmentLines(attachments)}`, text_elements: [] },
    ];
    for (const image of imageAttachments(attachments)) {
      input.push({ type: 'localImage', path: image.path, detail: 'auto' });
    }
    this.ensureStarted().then((threadId) => {
      if (this.dead || !threadId) { return; }
      const settings = codexSettings(this.mode);
      this.server.request('turn/start', {
        threadId,
        input,
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
   * Answers one parked question in codex's own response shape —
   * `{answers: {[id]: {answers: [...]}}}`, one entry per question in that
   * request (mirroring `respondToTool`'s per-method shape). A no-op if the
   * id names no parked request, e.g. it was already cancelled.
   */
  respondToQuestion(id: string, answers: QuestionAnswers): void {
    const rpcId = this.pendingQuestions.get(id);
    if (rpcId === undefined) { return; }
    this.pendingQuestions.delete(id);
    const mapped: ToolRequestUserInputResponse = { answers: {} };
    for (const [qid, values] of Object.entries(answers)) { mapped.answers[qid] = { answers: values }; }
    this.server.respond(rpcId, mapped);
  }

  /**
   * Answers every still-parked question with the structurally-valid empty
   * map — "answered nothing" — and reports the cancellation, mirroring how
   * `dispose()` already declines leftover approvals rather than leaving them
   * to hang. Called from both `interrupt()` and `dispose()`.
   */
  private cancelParkedQuestions(): void {
    for (const [id, rpcId] of this.pendingQuestions) {
      this.server.respond(rpcId, { answers: {} } satisfies ToolRequestUserInputResponse);
      this.events.push({ kind: 'request-cancelled', id });
    }
    this.pendingQuestions.clear();
  }

  /**
   * Declines every still-parked approval, each in its own request's response
   * shape, and reports the cancellation — the approval twin of
   * `cancelParkedQuestions` above, called from both `interrupt()` and
   * `dispose()` for the same reason.
   *
   * A v1 `{denied:{rejection}}` here is not a denial at all: it fails to
   * deserialize and the request stays parked.
   *
   * `request-cancelled` is what makes `interrupt()` converge: without it the
   * card stays rendered `pending`, `recomputeWaitingStatus` keeps the session
   * at `awaiting-approval` for a turn that no longer exists, and a later
   * Allow answers a request codex has already abandoned. The Claude bridge's
   * `cancelParked` emits the same event for the same reason.
   */
  private cancelParkedApprovals(): void {
    for (const [id, pending] of this.pendingApprovals) {
      if (pending.method === 'item/permissions/requestApproval') {
        const empty: PermissionsRequestApprovalResponse = { permissions: {}, scope: 'turn' };
        this.server.respond(pending.rpcId, empty);
      } else {
        const declined: FileChangeApprovalDecision = 'decline';
        this.server.respond(pending.rpcId, { decision: declined });
      }
      this.events.push({ kind: 'request-cancelled', id });
    }
    this.pendingApprovals.clear();
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
    // Both maps, not just the questions: a parked approval belongs to the turn
    // being stopped exactly as much as a parked question does, and leaving it
    // pins the session at `awaiting-approval` for a turn that is gone.
    this.cancelParkedApprovals();
    this.cancelParkedQuestions();
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
    // Left-over approvals and questions get settled rather than hanging
    // forever on a session that is going away — each in its own request's
    // response shape.
    this.cancelParkedApprovals();
    this.cancelParkedQuestions();
    // Every rejoined subagent thread first, unsubscribed directly rather
    // than through `leaveSubagentThread` — that helper's own `dead` guard
    // includes `disposed`, already true above, and would swallow every one
    // of these before it ever left.
    for (const agentThreadId of [...this.childThreads.keys()]) {
      this.childThreads.delete(agentThreadId);
      try {
        await this.server.request('thread/unsubscribe', { threadId: agentThreadId });
      } catch {
        // Best-effort: the connection may already be gone.
      }
    }
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
