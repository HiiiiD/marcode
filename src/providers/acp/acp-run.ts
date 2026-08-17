import { attachmentLines, imageAttachments, readBase64 } from '../attachment-payload';
import { formatEditorContext } from '../format-editor-context';
import type {
  AgentEvent, AgentRun, Attachment, ContextBreakdown, EditorContext,
  EffortLevel, PermissionMode, QuestionAnswers, ToolDecision,
} from '../types';
import { CLIENT_CAPABILITIES, connectAcp, PROTOCOL_VERSION, type AcpChild } from './acp-client';
import { currentModelId, modelConfigId, type ConfigOption } from './config-options';
import { toAgentEvents, toContextBreakdown, type AcpToolCall, type ToolMapper } from './map-updates';
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
  clientName: string;
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
  /** The in-flight `session/prompt`, if any. Never rejects — see `runPrompt`. */
  private promptPromise: Promise<void> | undefined;
  /** Set by `interrupt()`, cleared by the next `send()`. See `runPrompt`. */
  private interrupted = false;
  private disposed = false;

  /**
   * Attached only once a `usage_update` has actually arrived — `AgentSession`
   * reads this method's mere presence as "this provider reports context
   * usage", so resolving it from nothing would be a fabricated breakdown.
   * Same conditional shape as `CodexRun`'s, for the same reason.
   */
  private lastBreakdown: ContextBreakdown | undefined;
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

  /** Never rejects: a failed startup is a `turn-end` in the transcript, not an exception. */
  private async start(): Promise<void> {
    try {
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
        // `mcpServers: []` is not a gap: that parameter is for a CLIENT
        // injecting its own servers. The user's own servers load from their
        // agent config regardless, and listing them here would double them.
        const created = await conn.newSession({ cwd: this.opts.cwd, mcpServers: [] });
        this.sessionId = created.sessionId;
        this.applyConfigOptions(created.configOptions);
      }
      if (this.disposed || !this.sessionId) { return; }
      this.events.push({ kind: 'session', resumeToken: this.sessionId });
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
    } catch (err) {
      this.events.push({ kind: 'turn-end', reason: 'error', error: errorMessage(err) });
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
    const rpc = conn.loadSession({ sessionId, cwd: this.opts.cwd, mcpServers: [] })
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
    for (const event of toAgentEvents(p.update, this.opts.tools)) { this.events.push(event); }
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
    const decision = await new Promise<ToolDecision | undefined>((resolve) => {
      this.parked.set(id, resolve);
      this.events.push({
        kind: 'permission', id, tool: this.opts.tools.call(call), meta: { title: call.title },
      });
    });
    this.parked.delete(id);
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
        blocks.push({ type: 'image', data, mimeType: image.mediaType ?? 'application/octet-stream' });
      }
    }
    // Non-image attachments are named by path for the agent to read with its
    // own tools — the same rendering every other provider uses.
    const named = attachmentLines(attachments).trim();
    if (named) { blocks.push({ type: 'text', text: named }); }
    this.interrupted = false;
    this.promptPromise = this.runPrompt(blocks);
  }

  /** Never rejects — every failure becomes a `turn-end`, so `promptPromise` is always safe to await. */
  private async runPrompt(blocks: unknown[]): Promise<void> {
    await this.startup;
    const conn = this.conn;
    const sessionId = this.sessionId;
    if (this.disposed || !conn || !sessionId) { return; }
    // Interrupted before the session even existed: `interrupt()` had no
    // sessionId to cancel, so sending the prompt now would start the very turn
    // the user just stopped.
    if (this.interrupted) {
      this.events.push({ kind: 'turn-end', reason: 'interrupted' });
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
      this.events.push({ kind: 'turn-end', reason: 'error', error: errorMessage(err) });
    }
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
   * `plan` and `default` are the two modes ACP can express as a session mode;
   * every other mode is enforced in `onRequestPermission` instead, because ACP
   * hands the decision to the client (see `permissions.ts`).
   */
  setPermissionMode(mode: PermissionMode): void {
    this.mode = mode;
    const modeId = mode === 'plan' ? 'plan' : mode === 'default' ? 'build' : undefined;
    if (!modeId) { return; }
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
   * Deliberately does not await `startup` — a session still waiting on a
   * `session/load` that will never answer is exactly the one a user reaches
   * for Stop on, and an interrupt that hangs is not an interrupt.
   */
  async interrupt(): Promise<void> {
    this.interrupted = true;
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
    await this.promptPromise;
  }

  /**
   * Deliberately does not await `startup`: a run disposed while `initialize`
   * is still outstanding would otherwise wait for an answer that is never
   * coming — which is exactly the case a user closing a broken session is in.
   */
  async dispose(): Promise<void> {
    if (this.disposed) { return; }
    this.disposed = true;
    // Release the load gate before anything else, so a `start()` parked on it
    // unwinds rather than holding a 2s timer on a session that is gone.
    this.clearLoadTimer();
    this.loadIdle?.();
    // A request still parked is answered `cancelled` — not denied. Snapshot
    // first: each resolver deletes its own entry as it unwinds.
    for (const resolve of [...this.parked.values()]) { resolve(undefined); }
    this.parked.clear();
    const conn = this.conn;
    const sessionId = this.sessionId;
    if (conn && sessionId) {
      try {
        await conn.cancel({ sessionId });
      } catch {
        // Best-effort: the connection may already be gone.
      }
    }
    await this.promptPromise;
    this.events.close();
    this.child.kill();
  }
}
