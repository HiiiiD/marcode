import { attachmentLines, imageAttachments, readBase64 } from '../attachment-payload';
import { formatEditorContext } from '../format-editor-context';
import type {
  AgentEvent, AgentRun, Attachment, ContextBreakdown, EditorContext,
  EffortLevel, PermissionMode, QuestionAnswers, SelfControlMcpConfig, ToolDecision,
} from '../types';
import { CLIENT_CAPABILITIES, connectAcp, PROTOCOL_VERSION, type AcpChild } from './acp-client';
import { currentModelId, modelConfigId, toModeIds, type ConfigOption } from './config-options';
import {
  ToolCallLog, toAgentEvents, toContextBreakdown,
  type AcpToolCall, type ToolMapper,
} from './map-updates';
import { autoDecision, chooseOption, type PermissionOption, type PermissionOutcome } from './permissions';

/**
 * The connection `connectAcp` hands back, narrowed to the six calls this class
 * makes. Declaring it structurally keeps the SDK's ESM-only `.d.ts` out of this
 * module's import graph — `acp-client.ts` already owns that boundary — and it
 * is what lets the tests drive a real `ClientSideConnection` over a pair of
 * PassThroughs without a second type import.
 */
interface AcpConnection {
  initialize(params: unknown): Promise<unknown>;
  newSession(params: unknown): Promise<{ sessionId: string; configOptions?: unknown }>;
  loadSession(params: unknown): Promise<{ configOptions?: unknown } | undefined>;
  setSessionConfigOption(params: unknown): Promise<{ configOptions?: unknown } | undefined>;
  setSessionMode(params: unknown): Promise<unknown>;
  prompt(params: unknown): Promise<{ stopReason?: string; usage?: PromptUsage | null } | undefined>;
  cancel(params: unknown): Promise<void>;
}

interface PromptUsage { inputTokens: number; outputTokens: number }

export interface AcpRunOptions {
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  resumeToken?: string;
  tools: ToolMapper;
  /**
   * This agent's own session-mode name for a permission mode, or `undefined`
   * when it has no session mode that expresses one.
   *
   * The vendor half, exactly like `tools`: `'plan'` and `'build'` are names
   * OpenCode chose, and this layer's whole justification is that a second ACP
   * agent costs a spawn recipe and a couple of mappers. What `AcpRun` still
   * owns is *when* a mode is asserted, and checking the answer against the
   * ids the agent actually advertised — see `modeIdFor`.
   */
  modeId(mode: PermissionMode): string | undefined;
  clientName: string;
  /** The loopback MCP server this run's agent should connect to, if any. */
  selfControlMcp?: SelfControlMcpConfig;
}

/**
 * The `mcpServers` entry for `session/new`/`session/load`. Empty when no
 * self-control server is configured — the user's own servers still load from
 * their own agent config regardless, so an empty list here never means "no
 * MCP servers for this session", only "this client injected none of its own".
 */
function mcpServersFor(config: SelfControlMcpConfig | undefined): unknown[] {
  if (!config) { return []; }
  return [{
    type: 'http', name: 'marcode-self-control', url: config.url,
    headers: [{ name: 'Authorization', value: `Bearer ${config.token}` }],
  }];
}

/**
 * After this long with no replayed update, a `session/load` that has not
 * answered is treated as done. Measured on opencode 1.18.18: it replays the
 * whole history as `session/update` notifications BEFORE answering the RPC,
 * and from a foreign directory it replays and then never answers at all — so
 * an unconditional `await` on the reply is a session that never comes up.
 */
const LOAD_IDLE_MS = 2000;

/** Same async-iterable pattern as `CodexRun`'s — the house idiom for an `AgentRun.events`. */
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

/** ACP's stop reasons, in this project's vocabulary. Anything unknown is an error. */
function turnEndReason(stopReason: string | undefined): 'done' | 'interrupted' | 'error' {
  if (stopReason === 'end_turn') { return 'done'; }
  if (stopReason === 'cancelled') { return 'interrupted'; }
  return 'error';
}

/**
 * One ACP session, presented as an `AgentRun`.
 *
 * Vendor-neutral by construction: everything that knows what a tool *is*
 * arrives as the injected `ToolMapper`, so a second ACP agent needs a second
 * mapper and nothing here.
 *
 * The constructor is synchronous — `AgentProvider.start` returns an `AgentRun`,
 * not a promise — but the SDK loads through a dynamic `import()` (see
 * `acp-client.ts`), so startup is one memoized promise kicked off here and
 * awaited by every method that needs a live connection.
 */
export class AcpRun implements AgentRun {
  readonly events = new EventChannel();

  private conn: AcpConnection | undefined;
  private sessionId: string | undefined;

  /** Mutable, live settings — what a setter retargets. */
  private mode: PermissionMode;
  private model: string | undefined;

  /** The session's own config catalog, from `session/new` or a later write. */
  private configOptions: ConfigOption[] = [];
  private readonly configSubscribers: ((options: ConfigOption[]) => void)[] = [];

  /**
   * Every outstanding permission request, keyed by its tool-call id, resolved
   * by `respondToTool`.
   *
   * The resolver takes `ToolDecision | undefined` rather than the brief's bare
   * `ToolDecision`: `undefined` is how `dispose()` says "cancelled", which is a
   * third answer that neither `allow: true` nor `allow: false` can express —
   * an ACP `cancelled` outcome is not a rejection, and sending one as a
   * rejection would record a denial the user never made.
   */
  private readonly parked = new Map<string, (decision: ToolDecision | undefined) => void>();

  /**
   * True while a `session/load` is outstanding. Replayed history is swallowed:
   * our own transcript already holds it, and re-emitting it would double every
   * item on a restored session.
   */
  private loading = false;
  private loadIdle: (() => void) | undefined;
  private loadTimer: NodeJS.Timeout | undefined;

  private readonly startup: Promise<void>;
  /** Set by `interrupt()`, cleared by the next `send()`. See `runPrompt`. */
  private interrupted = false;
  /**
   * Why startup failed, if it did. Re-reported by every later `send()`: the
   * `turn-end` `start()` pushes is a one-off at construction, and a session
   * whose agent is broken must not go `running` forever the next time the user
   * types into it.
   */
  private startError: string | undefined;
  /**
   * Why the child process died, when the spawn recipe told us.
   *
   * The SDK reports a dead peer as the generic `"ACP connection closed"`,
   * which has no remedy in it. `AcpChild.onFailure` carries the exit
   * code/signal and the stderr tail — the thing a user can act on — and
   * `start()` already races it, but a crash *after* startup settled lands on
   * a promise nobody is awaiting. Retaining it here is what lets `runPrompt`
   * report the real reason instead. Respawning is deliberately not attempted.
   */
  private childFailure: string | undefined;
  private disposed = false;

  /**
   * Attached only once a `usage_update` has actually arrived — `AgentSession`
   * reads this method's mere presence as "this provider reports context
   * usage", so resolving it from nothing would be a fabricated breakdown.
   * Same conditional shape as `CodexRun`'s, for the same reason.
   */
  private lastBreakdown: ContextBreakdown | undefined;

  /** One session's tool calls, folded across the partial frames that describe them. */
  private readonly calls = new ToolCallLog();
  contextBreakdown?: () => Promise<ContextBreakdown>;

  constructor(
    private readonly child: AcpChild,
    private readonly opts: AcpRunOptions,
  ) {
    this.mode = opts.permissionMode;
    this.model = opts.model;
    this.startup = this.start();
  }

  /** Notified whenever this session's config catalog changes; fired immediately if one is known. */
  onSessionConfig(cb: (options: ConfigOption[]) => void): void {
    this.configSubscribers.push(cb);
    if (this.configOptions.length > 0) { cb(this.configOptions); }
  }

  // ---------------------------------------------------------------- startup

  /**
   * Never rejects: a failed startup is a `turn-end` in the transcript, not an
   * exception.
   *
   * Raced against `child.onFailure` — a spawn that never reaches a real
   * agent (a missing binary on Windows resolves to a shell that exits async;
   * see `spawnOpenCodeAcp`) never sends a reply, so the plain `await` chain
   * below would otherwise only ever fail via the SDK's own stream-close
   * handling, which rejects every pending request with the generic
   * `"ACP connection closed"` — a message with no remedy in it. `onFailure`
   * knows the real reason (exit code/signal, stderr tail) and reports it
   * first. A `reject` that loses the race lands on an already-settled
   * promise and is silently ignored, which is also why a *later* failure —
   * after startup already succeeded — never double-reports: this method has
   * already returned by then, and nothing here is still awaiting `failure`.
   */
  private async start(): Promise<void> {
    const failure = new Promise<never>((_, reject) => {
      this.child.onFailure?.((reason) => {
        this.childFailure = reason;
        reject(new Error(reason));
      });
    });
    try {
      await Promise.race([this.startInner(), failure]);
    } catch (err) {
      this.startError = errorMessage(err);
      this.events.push({ kind: 'turn-end', reason: 'error', error: this.startError });
    }
  }

  private async startInner(): Promise<void> {
    const conn = await connectAcp(this.child, {
      sessionUpdate: (params) => { this.onSessionUpdate(params); },
      requestPermission: (params) => this.onRequestPermission(params),
    }) as unknown as AcpConnection;
    this.conn = conn;
    if (this.disposed) { return; }

    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: { name: this.opts.clientName, version: '0.0.1' },
    });
    if (this.disposed) { return; }

    if (this.opts.resumeToken) {
      this.sessionId = this.opts.resumeToken;
      await this.loadGated(conn, this.opts.resumeToken);
    } else {
      // This is where the self-control server rides: `mcpServers` is for a
      // CLIENT injecting its own servers, and the self-control loopback
      // server is exactly that. The user's own servers still load from their
      // own agent config regardless, so this never doubles them.
      const created = await conn.newSession({
        cwd: this.opts.cwd, mcpServers: mcpServersFor(this.opts.selfControlMcp),
      });
      this.sessionId = created.sessionId;
      this.applyConfigOptions(created.configOptions);
    }
    if (this.disposed || !this.sessionId) { return; }
    this.events.push({ kind: 'session', resumeToken: this.sessionId });
    // ACP's `NewSessionRequest` carries NO mode field, and `AgentSession` only
    // calls `setPermissionMode` on a user change — so the mode a session was
    // created (or restored) with reaches the agent only if it is asserted
    // here. Without this, a `plan` session comes up in the agent's own default
    // and edits files on request while the pane's chip reads Plan: `plan` has
    // no client-side enforcement to compensate, because `autoDecision`
    // deliberately answers nothing for it.
    //
    // Awaited rather than fired and forgotten: `runPrompt` opens with
    // `await this.startup`, so awaiting here is what guarantees the mode is in
    // force before this session's first prompt can be sent.
    const startupModeId = this.modeIdFor(this.mode);
    if (startupModeId !== undefined) {
      try {
        await conn.setSessionMode({ sessionId: this.sessionId, modeId: startupModeId });
      } catch {
        // Its own catch, same as the model write below: a mode the agent
        // refuses is a worse session, not a dead one.
      }
    }
    // The session comes up on whatever model the agent's own config selects,
    // so a requested one is a write like any other — issued here rather than
    // through `setModel`, whose `fireAndForget` awaits the very promise this
    // is running inside.
    if (this.model && this.model !== currentModelId(this.configOptions)) {
      const configId = modelConfigId(this.configOptions) ?? 'model';
      try {
        const reply = await conn.setSessionConfigOption(
          { sessionId: this.sessionId, configId, value: this.model },
        );
        this.applyConfigOptions(reply?.configOptions);
      } catch {
        // Its own catch, not the one below: a model the agent will not take
        // leaves a working session on the agent's default. That is a worse
        // session, not a dead one, and must not read as a failed startup.
      }
    }
  }

  /**
   * `session/load` behind the idle gate: settled by the RPC's own answer or by
   * `LOAD_IDLE_MS` of silence, whichever comes first. See `LOAD_IDLE_MS`.
   */
  private async loadGated(conn: AcpConnection, sessionId: string): Promise<void> {
    this.loading = true;
    const idle = new Promise<void>((resolve) => { this.loadIdle = resolve; });
    this.armLoadTimer();
    // A `loadSession` reply may carry no config options at all — do not depend
    // on it. The catch is attached here, at creation, so a rejection that
    // arrives AFTER the idle timer already won the race is still handled.
    const rpc = conn.loadSession({
      sessionId, cwd: this.opts.cwd, mcpServers: mcpServersFor(this.opts.selfControlMcp),
    })
      .then((reply) => { this.applyConfigOptions(reply?.configOptions); });
    rpc.catch(() => { /* handled by the race below, or already settled */ });
    try {
      await Promise.race([rpc, idle]);
    } finally {
      this.loading = false;
      this.clearLoadTimer();
    }
  }

  private armLoadTimer(): void {
    this.clearLoadTimer();
    this.loadTimer = setTimeout(() => { this.loadIdle?.(); }, LOAD_IDLE_MS);
  }

  private clearLoadTimer(): void {
    if (this.loadTimer) { clearTimeout(this.loadTimer); }
    this.loadTimer = undefined;
  }

  private applyConfigOptions(options: unknown): void {
    if (!Array.isArray(options)) { return; }
    this.configOptions = options as ConfigOption[];
    for (const cb of this.configSubscribers) { cb(this.configOptions); }
  }

  // ------------------------------------------------------------- incoming

  private onSessionUpdate(params: unknown): void {
    // Replayed history: swallowed, and each one restarts the idle countdown.
    if (this.loading) { this.armLoadTimer(); return; }
    const p = (params ?? {}) as { sessionId?: string; update?: Record<string, unknown> };
    if (!p.update) { return; }
    // One connection serves one session here, but a stray id is still not ours.
    if (p.sessionId !== this.sessionId) { return; }

    if (p.update.sessionUpdate === 'usage_update') {
      this.captureUsage(p.update as { used?: unknown; size?: unknown });
      return;
    }
    for (const event of toAgentEvents(p.update, this.opts.tools, this.calls)) {
      this.events.push(event);
    }
  }

  /** `usage_update` feeds `contextBreakdown` and emits nothing — it is not a transcript item. */
  private captureUsage(update: { used?: unknown; size?: unknown }): void {
    if (typeof update.used !== 'number' || typeof update.size !== 'number') { return; }
    this.lastBreakdown = toContextBreakdown({ used: update.used, size: update.size });
    if (!this.contextBreakdown) {
      // Non-null by construction: this closure only exists once lastBreakdown
      // has been assigned, and nothing clears it back to undefined.
      this.contextBreakdown = (): Promise<ContextBreakdown> =>
        Promise.resolve(this.lastBreakdown as ContextBreakdown);
    }
  }

  /**
   * Deliberately NOT filtered by session id. Measured on opencode 1.18.18: the
   * `sessionId` on a `session/request_permission` is not the one `session/new`
   * answered with. One connection serves one session here, so this handler
   * answers whatever it is asked — and a blocking request left unanswered
   * hangs the turn with no card to answer it.
   */
  private async onRequestPermission(params: unknown): Promise<PermissionOutcome> {
    const p = (params ?? {}) as { toolCall?: AcpToolCall; options?: PermissionOption[] };
    const options = p.options ?? [];

    const auto = autoDecision(this.mode);
    if (auto) {
      // `preferAlways` only here: `bypass`/`dontAsk` mean "stop asking me for
      // this session", whereas a user's per-card Allow (below) is a one-time
      // allow and must never be widened into a standing grant.
      return chooseOption(options, auto, { preferAlways: true });
    }

    const call = p.toolCall;
    if (!call?.toolCallId) { return { outcome: { outcome: 'cancelled' } }; }
    const id = call.toolCallId;
    let own: ((decision: ToolDecision | undefined) => void) | undefined;
    const decision = await new Promise<ToolDecision | undefined>((resolve) => {
      own = resolve;
      const previous = this.parked.get(id);
      this.parked.set(id, resolve);
      // A second request reusing a tool-call id would otherwise orphan the
      // first, whose RPC then hangs unanswered for the rest of the session.
      // Cancelled, not denied — nobody decided anything about it.
      if (previous) { previous(undefined); }
      this.events.push({
        // Merged like any other frame: a permission request's `toolCall` is
        // as partial as the updates around it, and it shares their id.
        kind: 'permission', id, tool: this.opts.tools.call(this.calls.merge(call)),
        meta: { title: call.title },
      });
    });
    // Only if this call still owns the slot: an orphaned predecessor unwinding
    // here must not delete its successor's entry.
    if (this.parked.get(id) === own) { this.parked.delete(id); }
    if (!decision) { return { outcome: { outcome: 'cancelled' } }; }
    return chooseOption(options, decision);
  }

  // -------------------------------------------------------------- outgoing

  send(text: string, context?: EditorContext, attachments?: Attachment[]): void {
    const body = context ? `${formatEditorContext(context)}\n\n${text}` : text;
    const blocks: unknown[] = [{ type: 'text', text: body }];
    for (const image of imageAttachments(attachments)) {
      const data = readBase64(image);
      // A file that has gone since it was attached contributes nothing rather
      // than failing the turn.
      if (data) {
        // `image/png` is the fallback the Claude provider already uses for the
        // same field, and a pasted screenshot — the overwhelming majority of
        // image attachments — is a PNG.
        blocks.push({ type: 'image', data, mimeType: image.mediaType ?? 'image/png' });
      }
    }
    // Non-image attachments are named by path for the agent to read with its
    // own tools — the same rendering every other provider uses.
    const named = attachmentLines(attachments).trim();
    if (named) { blocks.push({ type: 'text', text: named }); }
    this.interrupted = false;
    void this.runPrompt(blocks);
  }

  /** Never rejects — every failure becomes a `turn-end`. */
  private async runPrompt(blocks: unknown[]): Promise<void> {
    await this.startup;
    if (this.disposed) { return; }
    // Interrupted before the session even existed: `interrupt()` had no
    // sessionId to cancel, so sending the prompt now would start the very turn
    // the user just stopped.
    if (this.interrupted) {
      this.events.push({ kind: 'turn-end', reason: 'interrupted' });
      return;
    }
    const conn = this.conn;
    const sessionId = this.sessionId;
    if (!conn || !sessionId) {
      // Startup failed and the user has typed anyway. Returning silently here
      // leaves the session `running` forever with nothing in the transcript
      // saying why: only a `turn-end` clears that status, and the one `start()`
      // pushed was consumed by the turn that had already ended.
      this.events.push({
        kind: 'turn-end', reason: 'error',
        error: this.startError ?? this.childFailure ?? 'The agent never started a session.',
      });
      return;
    }
    try {
      const reply = await conn.prompt({ sessionId, prompt: blocks });
      if (this.disposed) { return; }
      const usage = reply?.usage;
      if (usage) {
        this.events.push({
          kind: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        });
      }
      this.events.push({ kind: 'turn-end', reason: turnEndReason(reply?.stopReason) });
    } catch (err) {
      // A dead peer reaches us as the SDK's generic "ACP connection closed".
      // The child's own exit reason — code/signal plus the stderr tail — is
      // the one a user can act on, so it wins whenever the spawn recipe
      // reported one. See `childFailure`.
      this.events.push({
        kind: 'turn-end', reason: 'error', error: this.childFailure ?? errorMessage(err),
      });
    }
  }

  /**
   * Answers every still-parked permission `cancelled` and says so in the
   * transcript. Called from both `interrupt()` and `dispose()`.
   *
   * Cancelled, never denied: nobody decided anything about these. The
   * `request-cancelled` event is what makes the card stop rendering pending —
   * without it `recomputeWaitingStatus` holds the session at
   * `awaiting-approval` for a turn that no longer exists, and a later Allow
   * answers a request the agent has already abandoned. Both existing
   * providers emit it here for the same reason.
   */
  private cancelParked(): void {
    // Snapshot first: each resolver deletes its own entry as it unwinds.
    for (const [id, resolve] of [...this.parked.entries()]) {
      resolve(undefined);
      this.events.push({ kind: 'request-cancelled', id });
    }
    this.parked.clear();
  }

  respondToTool(id: string, decision: ToolDecision): void {
    const resolve = this.parked.get(id);
    if (!resolve) { return; }
    this.parked.delete(id);
    resolve(decision);
  }

  /** No-op: this provider surfaces no question cards. */
  respondToQuestion(_id: string, _answers: QuestionAnswers): void {
    // Intentionally empty.
  }

  setModel(model: string): void {
    this.model = model;
    this.writeConfigOption(modelConfigId(this.configOptions) ?? 'model', model);
  }

  /**
   * A no-op unless the agent actually offers a reasoning control. Writing a
   * config option the session never advertised is a guess, and a failed guess
   * would be indistinguishable from a real setting that did not take.
   */
  setEffort(effort: EffortLevel): void {
    const option = this.configOptions.find(
      (o) => o.category === 'thought_level' || o.category === 'reasoning'
        || o.id === 'thought_level' || o.id === 'reasoning',
    );
    if (!option) { return; }
    this.writeConfigOption(option.id, effort);
  }

  /**
   * The wire mode id to assert for a permission mode, or `undefined` when
   * there is none to assert.
   *
   * The vendor mapper names it; this checks that name against the ids the
   * session actually advertised, so a mapper written against a newer agent
   * cannot silently write a mode this one has never heard of. An EMPTY
   * catalog means "not known yet" — a resumed session may never receive one —
   * and must not be read as "this agent has no modes", or a reload would stop
   * asserting modes altogether.
   */
  private modeIdFor(mode: PermissionMode): string | undefined {
    const modeId = this.opts.modeId(mode);
    if (modeId === undefined) { return undefined; }
    const advertised = toModeIds(this.configOptions);
    if (advertised.length > 0 && !advertised.includes(modeId)) { return undefined; }
    return modeId;
  }

  /**
   * A `set_mode` goes out on EVERY change, not only the ones whose names line
   * up with a mode of the agent's.
   *
   * Plan mode is a wire-level session mode: once plan is sent, only an
   * explicit retraction takes the agent back out of it. Sending nothing for
   * `bypass` left the agent still refusing to edit while every permission
   * request was being auto-allowed — the panel saying one thing and the agent
   * doing another. Client-side enforcement in `onRequestPermission` is the
   * right home for *answering* permission requests, and is untouched by this;
   * it just cannot take the agent out of a mode the agent is holding.
   */
  setPermissionMode(mode: PermissionMode): void {
    this.mode = mode;
    const modeId = this.modeIdFor(mode);
    if (modeId === undefined) { return; }
    this.fireAndForget((conn, sessionId) => conn.setSessionMode({ sessionId, modeId }));
  }

  private writeConfigOption(configId: string, value: string): void {
    this.fireAndForget(async (conn, sessionId) => {
      const reply = await conn.setSessionConfigOption({ sessionId, configId, value });
      // The reply carries the WHOLE catalog back, because changing one option
      // may change another's available values.
      this.applyConfigOptions(reply?.configOptions);
    });
  }

  /**
   * The one path every setter goes down. `void`-returning by contract — a
   * caller must never see one of these reject — so the rejection handler is
   * attached where the promise is created, not left to a later `await` that
   * may never happen. A failed setter is logged and dropped: it must not end
   * a turn that is otherwise running fine.
   */
  private fireAndForget(work: (conn: AcpConnection, sessionId: string) => Promise<unknown>): void {
    void this.startup
      .then(() => {
        const conn = this.conn;
        const sessionId = this.sessionId;
        if (this.disposed || !conn || !sessionId) { return undefined; }
        return work(conn, sessionId);
      })
      .catch(() => { /* state, not an exception — and never a turn-end */ });
  }

  /**
   * Never waits on the peer's reply to the in-flight `session/prompt` RPC,
   * and never on `startup` either. A session still waiting on an
   * `initialize` or a `session/load` that will never answer is exactly the
   * one a user reaches for Stop on, and an interrupt that hangs is not an
   * interrupt — the same is true of a peer that accepts `session/cancel` but
   * then drops or never sends the `session/prompt` reply `runPrompt` is
   * waiting on: without a local, unconditional turn-end that peer would leave
   * the session wedged at `running`/`awaiting-approval` with a message parked
   * behind it forever, and this call itself never resolving either.
   */
  async interrupt(): Promise<void> {
    this.interrupted = true;
    // Before the cancel, not after. `session/cancel` is a NOTIFICATION and the
    // SDK does not abort inbound request handlers, so a parked permission
    // lives straight through it. Leaving one costs whichever failure the agent
    // picks: it answers the prompt `cancelled` and `recomputeWaitingStatus`
    // pins the session at `awaiting-approval` for a turn that no longer
    // exists.
    this.cancelParked();
    const conn = this.conn;
    const sessionId = this.sessionId;
    if (conn && sessionId) {
      try {
        await conn.cancel({ sessionId });
      } catch {
        // Best-effort: the user's intent was to stop either way. The turn's
        // own `stopReason: 'cancelled'` is what produces the turn-end.
      }
    }
    // Pushed unconditionally, mirroring codex-run.ts's `interrupt()`: if the
    // in-flight `session/prompt` reply does eventually arrive, `runPrompt`
    // pushes its own turn-end too — a harmless second one onto an
    // already-idle, already-drained session.
    this.events.push({ kind: 'turn-end', reason: 'interrupted' });
  }

  /**
   * Never awaits `startup`, directly or transitively: `AgentSession.dispose`
   * awaits this, `SessionManager.dispose` awaits all of them, so one agent
   * that never answered `initialize` would block the whole extension from
   * shutting down — and `child.kill()` below, the one thing that actually
   * reclaims the process, would never run. Killing the child is what cancels
   * an in-flight prompt here; there is no answer left to wait for once the
   * peer is gone.
   */
  async dispose(): Promise<void> {
    if (this.disposed) { return; }
    this.disposed = true;
    // Release the load gate before anything else, so a `start()` parked on it
    // unwinds rather than holding a 2s timer on a session that is gone.
    this.clearLoadTimer();
    this.loadIdle?.();
    this.cancelParked();
    const conn = this.conn;
    const sessionId = this.sessionId;
    if (conn && sessionId) {
      try {
        await conn.cancel({ sessionId });
      } catch {
        // Best-effort: the connection may already be gone.
      }
    }
    this.events.close();
    this.child.kill();
  }
}
