import type { AgentEvent, PermissionMeta, ToolCall, ToolDecision } from '../types';
import { subagentToolCall, subagentToolOutput, type RawToolPart } from './map-subagent-tools';

/**
 * The three raw event shapes this file reads, narrowed from
 * `@opencode-ai/sdk@1.18.30`'s published `Event` union
 * (`dist/v2/gen/types.gen.d.ts` — `EventSessionCreated`,
 * `EventMessagePartUpdated`, `EventPermissionAsked`). Anything else on the
 * global stream (models-dev refresh, pty, question, ...) is ignored.
 */
type RawEvent =
  | { type: 'session.created'; properties: { sessionID: string; info: { id: string; parentID?: string } } }
  | { type: 'message.part.updated'; properties: { sessionID: string; part: RawPart; time?: number } }
  | {
      type: 'permission.asked';
      properties: {
        id: string; sessionID: string; permission: string; patterns: string[];
        metadata: Record<string, unknown>; always: string[];
        tool?: { messageID: string; callID: string };
      };
    }
  | { type: string; properties?: unknown };

type RawPart = ({ type: 'tool' } & RawToolPart) | { type: string };

/**
 * `state.metadata.sessionId` off a `task` tool part — opencode writes it the
 * moment the part leaves `pending`, before the subagent runs anything, and a
 * resumed task (`task_id`) carries the same field naming its own session.
 */
function taskChildSessionId(part: RawToolPart): string | undefined {
  const { state } = part;
  if (state.status === 'pending') { return undefined; }
  const sessionId = state.metadata?.sessionId;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

/** The three `AgentEvent` kinds this file ever produces — all nestable. */
type NestableToolEvent = Extract<AgentEvent, { kind: 'tool-start' | 'tool-update' | 'tool-end' }>;

/**
 * `sdk.global.event()`/`sdk.permission.reply(...)`, narrowed to the two
 * calls this file makes — same structural-narrowing move `AcpConnection`
 * makes in `acp-run.ts`, so a test scripts a fake without importing the SDK.
 */
export interface SubagentSdk {
  globalEvent(): Promise<{ stream: AsyncIterable<{ payload?: unknown }> }>;
  permissionReply(params: { requestID: string; reply: 'once' | 'always' | 'reject'; directory?: string }): Promise<unknown>;
}

/**
 * `@opencode-ai/sdk` ships ESM-only — dynamic `import()`, same reasoning and
 * shape as `acp-client.ts`'s `connectAcp`.
 *
 * `signal` is threaded into the client as a `RequestInit` default: the
 * generated SSE transport (`global.event()`) retries a dropped connection
 * forever on its own (exponential backoff up to 30s) unless handed a signal
 * it can check — `close()` aborting it is the only thing that ever stops
 * that loop once a server is unreachable, in production and in a test alike.
 */
async function connectSdk(baseUrl: string, token: string, signal?: AbortSignal): Promise<SubagentSdk> {
  const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
  const client = createOpencodeClient({
    baseUrl, signal, headers: { Authorization: `Basic ${Buffer.from(`opencode:${token}`).toString('base64')}` },
  });
  return {
    globalEvent: () => client.global.event() as unknown as Promise<{ stream: AsyncIterable<{ payload?: unknown }> }>,
    permissionReply: (params) => client.permission.reply(params),
  };
}

/** Same house idiom `AcpRun`'s `EventChannel` uses. */
class EventChannel implements AsyncIterable<AgentEvent> {
  private queue: AgentEvent[] = [];
  private waiting: ((v: IteratorResult<AgentEvent>) => void) | undefined;
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) { return; }
    if (this.waiting) { const r = this.waiting; this.waiting = undefined; r({ value: event, done: false }); }
    else { this.queue.push(event); }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) { const r = this.waiting; this.waiting = undefined; r({ value: undefined as never, done: true }); }
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

export interface SubagentWatchOptions {
  /** Injected so a test never opens a real socket. Defaults to `connectSdk`. */
  connect?: (baseUrl: string, token: string, signal?: AbortSignal) => Promise<SubagentSdk>;
}

/**
 * Watches one opencode server's global event stream for sessions spawned
 * (directly or transitively) by this run's own root session, and republishes
 * their tool calls and permission asks as ordinary nested `AgentEvent`s.
 * Read-only: never sends a prompt, never steers a child session.
 */
export class SubagentWatch {
  readonly events = new EventChannel();

  private readonly watched = new Set<string>();
  /** Watched child session id -> the parent tool-start id its events nest under. */
  private readonly parentToolCallId = new Map<string, string>();
  /**
   * Watched session id -> the session that spawned it, from `session.created`.
   * A grandchild's nesting target is its nearest ancestor's, and that ancestor
   * only learns its own long after the grandchild exists — so the link is
   * recorded when it is known and resolved when it is needed. See
   * `nestingIdFor`.
   */
  private readonly parentSession = new Map<string, string>();
  /**
   * Events already translated for a watched child whose nesting target isn't
   * known yet — flushed once `setParentToolCallId` learns it. Nearly always
   * empty: `handlePart`'s live correlation (see `taskChildSessionId`) usually
   * settles this within one event; `onSubagentSpawned` is the slower fallback
   * for the events between.
   */
  private readonly pending = new Map<string, NestableToolEvent[]>();
  private rootSessionId: string | undefined;
  private permissionHandler:
    | ((id: string, tool: ToolCall, meta: PermissionMeta | undefined, parentId: string | undefined)
        => Promise<ToolDecision | undefined>)
    | undefined;
  private closed = false;
  private sdk: SubagentSdk | undefined;
  /** Aborts the real SSE connection's own retry loop — see `run`/`close`. */
  private abortController: AbortController | undefined;

  constructor(private readonly opts: SubagentWatchOptions = {}) {}

  /**
   * Starts watching `baseUrl` with `token`. Not called from the constructor:
   * `opencode-provider.ts` only learns the real port after an async
   * reservation, and connecting eagerly at construction would race that
   * reservation with an empty URL. A `SubagentWatch` `open` is never called
   * on stays permanently idle — correct for a spawn attempt that fails
   * before reaching this point, nothing further to guard.
   */
  open(baseUrl: string, token: string): void {
    // A retried spawn (`opencode-provider.ts`'s `attemptSpawn`) calls `open`
    // again with a fresh port — abort whatever connection attempt is still
    // pending against the port that just failed, or it leaks forever
    // alongside the new one.
    this.abortController?.abort();
    this.abortController = new AbortController();
    void this.run(baseUrl, token, this.abortController.signal);
  }

  setRootSessionId(id: string): void {
    this.rootSessionId = id;
    this.watched.add(id);
  }

  /** The parent's own `task` tool-start id — every event from `childId` nests under it. */
  setParentToolCallId(childId: string, toolStartId: string): void {
    this.parentToolCallId.set(childId, toolStartId);
    this.watched.add(childId);
    // Every buffered session, not just `childId`: a grandchild's target is its
    // nearest ancestor's, so learning one can settle several at once.
    for (const [sessionId, buffered] of [...this.pending]) {
      const parentId = this.nestingIdFor(sessionId);
      if (!parentId) { continue; }
      this.pending.delete(sessionId);
      for (const event of buffered) { this.events.push({ ...event, parentId }); }
    }
  }

  /**
   * The tool-start id this session's events nest under — its own, or the
   * nearest ancestor's, since every watched descendant nests under the same
   * top-level `task` card. `undefined` while no ancestor knows one yet, which
   * is the whole first half of a subagent's life. The hop cap is the same
   * malformed-cycle guard `agent-session.ts`'s `resolveParent` uses.
   */
  private nestingIdFor(sessionId: string): string | undefined {
    let current: string | undefined = sessionId;
    for (let hops = 0; current !== undefined && hops < 8; hops++) {
      const known = this.parentToolCallId.get(current);
      if (known) { return known; }
      current = this.parentSession.get(current);
    }
    return undefined;
  }

  setPermissionHandler(
    handler: (id: string, tool: ToolCall, meta: PermissionMeta | undefined, parentId: string | undefined)
      => Promise<ToolDecision | undefined>,
  ): void {
    this.permissionHandler = handler;
  }

  close(): void {
    this.closed = true;
    this.abortController?.abort();
    this.events.close();
  }

  private async run(baseUrl: string, token: string, signal: AbortSignal): Promise<void> {
    const connect = this.opts.connect ?? connectSdk;
    try {
      const sdk = await connect(baseUrl, token, signal);
      // An older attempt's `connect` resolving late would otherwise install a
      // client pointed at the port that already failed, over the one `open()`
      // just replaced it with.
      if (this.closed || signal.aborted) { return; }
      this.sdk = sdk;
      const { stream } = await sdk.globalEvent();
      for await (const envelope of stream) {
        if (this.closed) { return; }
        if (envelope.payload) { this.handle(envelope.payload as RawEvent); }
      }
    } catch {
      // Best-effort tap: a dead connection here degrades to "no nested
      // subagent visibility", never to a failed run — see the design doc's
      // Error handling section.
    }
  }

  private handle(event: RawEvent): void {
    if (event.type === 'session.created') {
      const props = event.properties as Extract<RawEvent, { type: 'session.created' }>['properties'];
      const { sessionID, info } = props;
      // Parentage alone enrolls a session: "is this one of ours" is a
      // different question from "where do its events nest", and the second
      // has no answer until the parent's `task` call completes. Gating
      // enrollment on the second is what made every live event unreachable.
      if (info.parentID && this.watched.has(info.parentID) && !this.watched.has(sessionID)) {
        this.watched.add(sessionID);
        this.parentSession.set(sessionID, info.parentID);
      }
      return;
    }
    if (event.type === 'message.part.updated') {
      const props = event.properties as Extract<RawEvent, { type: 'message.part.updated' }>['properties'];
      this.handlePart(props.sessionID, props.part);
      return;
    }
    if (event.type === 'permission.asked') {
      const props = event.properties as Extract<RawEvent, { type: 'permission.asked' }>['properties'];
      this.handlePermission(props);
    }
  }

  private handlePart(sessionId: string, part: RawPart): void {
    if (part.type !== 'tool') { return; }
    const toolPart = part as RawToolPart;
    // Narrow carve-out from the root-exclusion guard below: read a `task`
    // part's own correlation metadata off any session we watch, root
    // included, without publishing the part itself — the root's own card
    // already renders via ACP, and a watched child's `task` call still gets
    // its ordinary nested-card treatment further down.
    if ((sessionId === this.rootSessionId || this.watched.has(sessionId)) && toolPart.tool.toLowerCase() === 'task') {
      const childSessionId = taskChildSessionId(toolPart);
      if (childSessionId) {
        const correlationId = sessionId === this.rootSessionId ? toolPart.callID : `${sessionId}:${toolPart.callID}`;
        this.setParentToolCallId(childSessionId, correlationId);
      }
    }
    // The root is in `watched` too (see `setRootSessionId`), but its own tool
    // calls already reach the transcript down ACP's normal path — republishing
    // them here would double every card the user sees.
    if (sessionId === this.rootSessionId || !this.watched.has(sessionId)) { return; }
    const tool = subagentToolCall(toolPart);
    // Namespaced like the permission ids below: `callID` is only unique within
    // its own session, and an unnamespaced collision with the root's own tool
    // call would fold two unrelated cards into one.
    const id = `${sessionId}:${toolPart.callID}`;
    const event: NestableToolEvent = toolPart.state.status === 'pending'
      ? { kind: 'tool-start', id, tool }
      : toolPart.state.status === 'running'
        ? { kind: 'tool-update', id, tool }
        : {
            kind: 'tool-end', id, ok: toolPart.state.status === 'completed',
            output: subagentToolOutput(toolPart), tool,
          };
    const parentId = this.nestingIdFor(sessionId);
    if (parentId) {
      this.events.push({ ...event, parentId });
    } else {
      const buffered = this.pending.get(sessionId) ?? [];
      buffered.push(event);
      this.pending.set(sessionId, buffered);
    }
  }

  private handlePermission(properties: {
    id: string; sessionID: string; permission: string; metadata: Record<string, unknown>;
    tool?: { messageID: string; callID: string };
  }): void {
    // Same root exclusion as `handlePart`: the root's own asks already travel
    // ACP's `session/request_permission` path, and relaying them here too
    // would raise a second card nothing can ever answer.
    if (properties.sessionID === this.rootSessionId || !this.watched.has(properties.sessionID)) { return; }
    if (!this.permissionHandler) { return; }
    const namespacedId = `${properties.sessionID}:${properties.id}`;
    const tool: ToolCall = { kind: 'other', label: properties.permission, raw: properties.metadata };
    // Never buffered, unlike `handlePart`: a child blocked on an unanswered
    // permission never reaches the `task` completion that would reveal where
    // to nest it, so waiting for a nesting target is a deadlock. An ask that
    // fires before completion renders top-level for its own lifetime; the
    // child's other events still nest correctly once completion resolves.
    const parentId = this.nestingIdFor(properties.sessionID);
    // Permission events are emitted by the run's own handleAuxiliaryPermission
    // (Task 2), not here — this class only republishes tool activity. The
    // handler callback IS that run's method, which parks the decision and
    // pushes a permission event onto the run's channel. We only need to call
    // the handler and relay the decision back to the SDK.
    void this.permissionHandler(namespacedId, tool, { title: properties.permission }, parentId)
      .then((decision) => this.replyPermission(properties.id, decision))
      .catch(() => this.replyPermission(properties.id, undefined));
  }

  private replyPermission(requestID: string, decision: ToolDecision | undefined): void {
    if (!this.sdk) { return; }
    const reply = !decision ? 'reject' : decision.allow ? 'once' : 'reject';
    void this.sdk.permissionReply({ requestID, reply, directory: undefined }).catch(() => {});
  }
}
