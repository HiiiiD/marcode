import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { MemoryStore } from '../memory/types';
import type { PermissionMode } from '../protocol/messages';
import type { SelfControlMcpConfig } from '../providers/types';

/**
 * The slice of `SessionManager` this server needs. Declared structurally, not
 * imported from `session-manager.ts`, so this module carries no `vscode`
 * import in its graph and stays unit-testable with a fake — the same
 * boundary `message-router.ts` keeps for the same reason.
 */
/** What `get()` hands back for a resolved session — see its doc for why the result may be sync or async. */
type LiveSessionLike = {
  interrupt(): Promise<void>;
  send(text: string, context?: unknown, refs?: unknown, fileRefs?: unknown,
    from?: { sessionId: string; name: string }): void;
} | undefined;

export interface SessionManagerLike {
  catalog(): { id: string; models: { id: string }[]; permissionModes: { id: string }[] }[];
  create(
    providerId: string, cwd: string, model?: string, effort?: undefined, mode?: PermissionMode,
  ): Promise<{ state: { id: string } }>;
  /** Every non-archived session's addressable identity — see `marcode__list_sessions`. */
  summaries(): { id: string; name: string; providerId: string; status: string; cwd: string; archived: boolean }[];
  /** The ids of sessions with an open pane right now — see `marcode__list_sessions`. */
  visibleIds(): string[];
  /**
   * Materializes and returns the session, if it exists — used to resolve the
   * caller's own identity and to deliver to a target. `summaries()` spans
   * every non-archived session, live or merely restored from disk, so a
   * target `marcode__list_sessions` just named may have no live
   * `AgentSession` yet. The real implementation (`extension.ts`'s closure)
   * is expected to open one, mirroring `message-router.ts`'s own `reopen()`,
   * so `marcode__send_message` can actually reach it rather than reporting
   * "not available" for a session it just advertised. Sync-or-Promise
   * (rather than always `Promise`) so `SessionManager.get()` itself — always
   * synchronous, and used directly as a `SessionManagerLike` in tests —
   * still satisfies this structurally; the one call site always `await`s it.
   */
  get(id: string): Promise<LiveSessionLike> | LiveSessionLike;
}

const PORT_ATTEMPTS = 5;
/** Ephemeral port range; low enough to avoid the small set of IANA-reserved ports. */
const PORT_MIN = 20000;
const PORT_MAX = 60000;

function randomPort(): number {
  return PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN));
}

/**
 * One loopback HTTP MCP server, shared by every session this window runs —
 * see the design doc for why one server beats a per-backend mechanism.
 * Exposes exactly one tool, `marcode__spawn_session`. `start()`/`dispose()`
 * bracket its lifetime; `activate()`/`deactivate()` are the only real caller.
 */
export class SelfControlMcpServer {
  private http: Server | undefined;
  private readonly token = randomBytes(24).toString('hex');

  constructor(
    private readonly sessionManager: SessionManagerLike,
    private readonly memory?: MemoryStore,
  ) {}

  /**
   * Registers the one tool on a fresh `McpServer`. Called per request (see
   * `start()`) rather than once — the SDK correlates JSON-RPC requests to
   * responses on the raw id, transport-globally, and two independent MCP
   * clients naturally reuse small integer ids (1, 2, 3...). A single
   * long-lived transport shared by every session let one session's response
   * be misdelivered to another's overlapping tool call. Registration itself
   * is cheap — one function, no per-connection state — so rebuilding it per
   * request costs nothing that matters.
   */
  private buildMcpServer(sid: string | undefined): McpServer {
    const mcp = new McpServer({ name: 'marcode-self-control', version: '1.0.0' });

    /** The calling session's own name, resolved from `sid` — undefined if `sid` is missing or stale. */
    const caller = () => {
      if (!sid) { return undefined; }
      return this.sessionManager.summaries().find((s) => s.id === sid && !s.archived);
    };

    mcp.registerTool(
      'marcode__spawn_session',
      {
        title: 'Spawn a new Marcode session',
        description: 'Marcode-specific: creates a new top-level Marcode session (its own pane, '
          + 'own provider/model, own conversation) and sends it an initial prompt — NOT a '
          + 'subagent of this conversation and unrelated to any built-in Task/subagent tool you '
          + 'have. Use this to hand off independent work to a separate, freestanding session. '
          + 'Returns the new session\'s id.',
        inputSchema: {
          provider: z.string().describe('A provider id from this window\'s catalog, e.g. "claude".'),
          model: z.string().optional().describe('A model id the chosen provider offers. Omit for its default.'),
          mode: z.string().optional().describe('A permission mode id the chosen provider offers. Omit for "default".'),
          cwd: z.string().describe('Absolute working directory for the new session.'),
          prompt: z.string().describe('The first message sent to the new session.'),
        },
      },
      async ({ provider, model, mode, cwd, prompt }) => {
        const entry = this.sessionManager.catalog().find((p) => p.id === provider);
        if (!entry) {
          return { isError: true, content: [{ type: 'text', text: `Unknown or unavailable provider: ${provider}` }] };
        }
        if (model !== undefined && !entry.models.some((m) => m.id === model)) {
          return { isError: true, content: [{ type: 'text', text: `Provider ${provider} has no model ${model}` }] };
        }
        const modeId = mode as PermissionMode | undefined;
        if (modeId !== undefined && !entry.permissionModes.some((m) => m.id === modeId)) {
          return { isError: true, content: [{ type: 'text', text: `Provider ${provider} has no mode ${mode}` }] };
        }
        // `bypass` skips every permission check. A session running in a
        // restricted mode (e.g. `plan`) must not be able to delegate around
        // its own restriction by spawning a `bypass` child — regardless of
        // whether the target provider's own catalog happens to list `bypass`
        // among its modes.
        if (modeId === 'bypass') {
          return {
            isError: true,
            content: [{ type: 'text', text: 'spawn_session cannot create bypass-mode sessions' }],
          };
        }
        // Absolute-path check only: this module deliberately carries no
        // `vscode` import (see the class doc), so it has no clean way to
        // consult `vscode.workspace.workspaceFolders` without introducing
        // one. A relative `cwd` is rejected outright as the cheap, always
        // available check; confining it to known workspace roots is left for
        // a follow-up that either threads folder list in or accepts the
        // import. See the spec's Error handling section for the same note.
        if (!path.isAbsolute(cwd)) {
          return { isError: true, content: [{ type: 'text', text: `cwd must be an absolute path: ${cwd}` }] };
        }
        try {
          const session = await this.sessionManager.create(provider, cwd, model, undefined, modeId);
          // `send` is deliberately not part of `SessionManagerLike`: the manager
          // hands back a live session object, and this is the same shape
          // `MessageRouter`'s 'send' case calls — see agent-session.ts's `send`.
          // Guarded rather than asserted, so a minimal `SessionManagerLike` fake
          // (one that only satisfies the structural type, without a real
          // `AgentSession` behind it) doesn't blow up delivering the prompt.
          const sendable = session as unknown as { send?: (text: string) => void };
          if (typeof sendable.send === 'function') { sendable.send(prompt); }
          return { content: [{ type: 'text', text: JSON.stringify({ sessionId: session.state.id }) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
        }
      },
    );

    mcp.registerTool(
      'marcode__recall',
      {
        title: 'Search past Marcode sessions',
        description: 'Marcode-specific: searches OTHER, previously closed Marcode sessions in '
          + 'this workspace (any provider) for a keyword or phrase — not your own conversation '
          + 'history and unrelated to any built-in memory/recall tool you have, which only sees '
          + 'this one conversation. Use this to find what a different session already figured '
          + 'out. Returns short snippets, not full transcripts — call marcode__recall_fetch on a '
          + 'specific result to read more.',
        inputSchema: {
          query: z.string().describe('Keywords to search for.'),
          providerId: z.string().optional().describe('Restrict to one provider, e.g. "claude".'),
          limit: z.number().optional().describe('Max results. Defaults to 20.'),
        },
      },
      async ({ query, providerId, limit }) => {
        if (!this.memory) {
          return { isError: true, content: [{ type: 'text', text: 'Memory search is unavailable in this window.' }] };
        }
        const hits = await this.memory.search(query, { providerId, limit });
        return { content: [{ type: 'text', text: JSON.stringify(hits) }] };
      },
    );

    mcp.registerTool(
      'marcode__recall_fetch',
      {
        title: 'Fetch a past session\'s transcript slice',
        description: 'Marcode-specific companion to marcode__recall: reads a bounded slice of '
          + 'that OTHER session\'s transcript, anchored at one of its results. Never call this '
          + 'speculatively or with an id you invented — always call marcode__recall first and '
          + 'pass back its sessionId/itemId.',
        inputSchema: {
          sessionId: z.string().describe('A sessionId from a marcode__recall result.'),
          itemId: z.string().describe('The itemId from that same result.'),
        },
      },
      async ({ sessionId, itemId }) => {
        if (!this.memory) {
          return { isError: true, content: [{ type: 'text', text: 'Memory search is unavailable in this window.' }] };
        }
        const detail = await this.memory.fetch({ sessionId, itemId });
        return { content: [{ type: 'text', text: JSON.stringify(detail) }] };
      },
    );

    mcp.registerTool(
      'marcode__list_sessions',
      {
        title: 'List Marcode sessions',
        description: 'Marcode-specific: lists the OTHER Marcode sessions (any provider) currently '
          + 'open in a split pane in this window, so marcode__send_message can address one — not '
          + 'a list of files, tabs, or anything editor-related, and not the same thing as a generic '
          + '"ListAgents"/"list my teammates" harness tool, which lists your own harness\'s agents, '
          + 'not the sessions in this VS Code panel. Your own entry is marked "self": true — call '
          + 'this to find out your own name.',
        inputSchema: {},
      },
      async () => {
        const visible = new Set(this.sessionManager.visibleIds());
        const sessions = this.sessionManager.summaries()
          .filter((s) => !s.archived && (visible.has(s.id) || s.id === sid))
          .map((s) => ({
            name: s.name, providerId: s.providerId, status: s.status, cwd: s.cwd,
            ...(s.id === sid ? { self: true } : {}),
          }));
        return { content: [{ type: 'text', text: JSON.stringify(sessions) }] };
      },
    );

    mcp.registerTool(
      'marcode__send_message',
      {
        title: 'Send a message to another Marcode session',
        description: 'Marcode-specific: delivers text to a DIFFERENT, independent Marcode session '
          + '(possibly a different provider entirely — Claude, Codex, OpenCode), interrupting it '
          + 'if it is mid-turn. If your harness also offers a generic "SendMessage"/"message another '
          + 'agent" tool, that one is unrelated — it addresses your own harness\'s agents, not the '
          + 'sessions in this VS Code panel; use marcode__send_message for those. This is not a '
          + 'message to yourself, the user, or a subagent of this conversation. Get the target name '
          + 'from marcode__list_sessions first. Delivery is immediate and does not wait for a reply '
          + '— a reply, if any, is that session calling marcode__send_message back.',
        inputSchema: {
          to: z.string().describe('The target session\'s name, from marcode__list_sessions.'),
          text: z.string().describe('The message to deliver.'),
        },
      },
      async ({ to, text }) => {
        const from = caller();
        if (!from) {
          return { isError: true, content: [{ type: 'text', text: 'Could not identify the calling session.' }] };
        }
        // Case-insensitive, matching `SessionManager.rename()`'s own
        // uniqueness rule: names are unique per window without regard to
        // case, so resolution here must agree with what a collision means.
        if (to.toLowerCase() === from.name.toLowerCase()) {
          return { isError: true, content: [{ type: 'text', text: 'Cannot send a message to yourself.' }] };
        }
        const target = this.sessionManager.summaries()
          .find((s) => s.name.toLowerCase() === to.toLowerCase() && !s.archived);
        if (!target) {
          return { isError: true, content: [{ type: 'text', text: `Unknown session: ${to}` }] };
        }
        const session = await this.sessionManager.get(target.id);
        if (!session) {
          return { isError: true, content: [{ type: 'text', text: `Session ${to} is not available.` }] };
        }
        await session.interrupt();
        session.send(text, undefined, undefined, undefined, { sessionId: from.id, name: from.name });
        return { content: [{ type: 'text', text: JSON.stringify({ delivered: true }) }] };
      },
    );

    return mcp;
  }

  async start(): Promise<SelfControlMcpConfig> {
    const http = createServer((req, res) => {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${this.token}`) {
        res.writeHead(401).end();
        return;
      }
      // Stateless per-request construction — see `buildMcpServer()`'s doc.
      // Each request gets its own `McpServer` + transport, so JSON-RPC ids
      // never collide across concurrent sessions' clients. `res.on('close')`
      // closes the transport once the response is done, whether it finished
      // normally or the client disconnected early, so nothing leaks.
      const sid = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('sid') ?? undefined;
      const mcp = this.buildMcpServer(sid);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // The test client (and the callers this mirrors: a provider's MCP client
        // over stdio-style JSON-RPC) reads one JSON body per response — no need
        // for the SSE streaming mode this transport also supports.
        enableJsonResponse: true,
      });
      res.on('close', () => { void transport.close(); });
      void mcp.connect(transport).then(() => transport.handleRequest(req, res)).catch((err: unknown) => {
        console.error('[mar-code] self-control MCP request failed', err);
        if (!res.headersSent) { res.writeHead(500).end(); }
      });
    });

    const port = await this.listen(http);
    this.http = http;
    return { url: `http://127.0.0.1:${port}/mcp`, token: this.token };
  }

  private listen(http: Server): Promise<number> {
    return new Promise((resolve, reject) => {
      const attempt = (tries: number): void => {
        const port = randomPort();
        const onError = (err: NodeJS.ErrnoException) => {
          http.removeListener('listening', onListening);
          if (err.code === 'EADDRINUSE' && tries > 1) { attempt(tries - 1); return; }
          reject(err);
        };
        const onListening = () => {
          http.removeListener('error', onError);
          // A permanent, swallowing listener that survives past the bind
          // attempts above (those use `once`, scoped to the retry loop).
          // Without one, any post-bind 'error' on the `Server` — e.g. EMFILE
          // — has zero listeners and becomes an unhandled EventEmitter
          // error: an uncaught exception in the extension host. Same hazard,
          // same posture as `codex-provider.ts`'s `child.stderr?.on('error',
          // () => {})`.
          http.on('error', (err) => {
            console.error('[mar-code] self-control MCP server error', err);
          });
          resolve(port);
        };
        http.once('error', onError);
        http.once('listening', onListening);
        http.listen(port, '127.0.0.1');
      };
      attempt(PORT_ATTEMPTS);
    });
  }

  async dispose(): Promise<void> {
    const http = this.http;
    this.http = undefined;
    if (!http) { return; }
    await new Promise<void>((resolve) => { http.close(() => resolve()); });
  }
}
