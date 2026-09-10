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
 */
async function connectSdk(baseUrl: string, token: string): Promise<SubagentSdk> {
  const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
  const client = createOpencodeClient({
    baseUrl, headers: { Authorization: `Basic ${Buffer.from(`opencode:${token}`).toString('base64')}` },
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
  connect?: (baseUrl: string, token: string) => Promise<SubagentSdk>;
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
  private rootSessionId: string | undefined;
  private permissionHandler:
    | ((id: string, tool: ToolCall, meta: PermissionMeta | undefined, parentId: string | undefined)
        => Promise<ToolDecision | undefined>)
    | undefined;
  private closed = false;
  private sdk: SubagentSdk | undefined;

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
    void this.run(baseUrl, token);
  }

  setRootSessionId(id: string): void {
    this.rootSessionId = id;
    this.watched.add(id);
  }

  /** The parent's own `task` tool-start id — every event from `childId` nests under it. */
  setParentToolCallId(childId: string, toolStartId: string): void {
    this.parentToolCallId.set(childId, toolStartId);
    this.watched.add(childId);
  }

  setPermissionHandler(
    handler: (id: string, tool: ToolCall, meta: PermissionMeta | undefined, parentId: string | undefined)
      => Promise<ToolDecision | undefined>,
  ): void {
    this.permissionHandler = handler;
  }

  close(): void {
    this.closed = true;
    this.events.close();
  }

  private async run(baseUrl: string, token: string): Promise<void> {
    const connect = this.opts.connect ?? connectSdk;
    try {
      this.sdk = await connect(baseUrl, token);
      const { stream } = await this.sdk.globalEvent();
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
      if (info.parentID && this.watched.has(info.parentID) && !this.parentToolCallId.has(sessionID)) {
        // A grandchild inherits its parent's own nesting target — every
        // watched descendant nests under the same top-level `task` card.
        const parentToolStart = this.parentToolCallId.get(info.parentID);
        if (parentToolStart) { this.setParentToolCallId(sessionID, parentToolStart); }
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
    const parentId = this.parentToolCallId.get(sessionId);
    if (!parentId) { return; }
    const tool = subagentToolCall(toolPart);
    if (toolPart.state.status === 'pending') {
      this.events.push({ kind: 'tool-start', id: toolPart.callID, tool, parentId });
    } else if (toolPart.state.status === 'running') {
      this.events.push({ kind: 'tool-update', id: toolPart.callID, tool, parentId });
    } else {
      this.events.push({
        kind: 'tool-end', id: toolPart.callID, ok: toolPart.state.status === 'completed',
        output: subagentToolOutput(toolPart), tool, parentId,
      });
    }
  }

  private handlePermission(properties: {
    id: string; sessionID: string; permission: string; metadata: Record<string, unknown>;
    tool?: { messageID: string; callID: string };
  }): void {
    const parentId = this.parentToolCallId.get(properties.sessionID);
    if (!parentId || !this.permissionHandler) { return; }
    const namespacedId = `${properties.sessionID}:${properties.id}`;
    const tool: ToolCall = { kind: 'other', label: properties.permission, raw: properties.metadata };
    this.events.push({ kind: 'permission', id: namespacedId, tool, parentId, meta: { title: properties.permission } });
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
