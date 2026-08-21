import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { PermissionMode } from '../protocol/messages';
import type { SelfControlMcpConfig } from '../providers/types';

/**
 * The slice of `SessionManager` this server needs. Declared structurally, not
 * imported from `session-manager.ts`, so this module carries no `vscode`
 * import in its graph and stays unit-testable with a fake — the same
 * boundary `message-router.ts` keeps for the same reason.
 */
export interface SessionManagerLike {
  catalog(): { id: string; models: { id: string }[]; permissionModes: { id: string }[] }[];
  create(
    providerId: string, cwd: string, model?: string, effort?: undefined, mode?: PermissionMode,
  ): Promise<{ state: { id: string } }>;
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

  constructor(private readonly sessionManager: SessionManagerLike) {}

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
  private buildMcpServer(): McpServer {
    const mcp = new McpServer({ name: 'marcode-self-control', version: '1.0.0' });
    mcp.registerTool(
      'marcode__spawn_session',
      {
        title: 'Spawn a new Marcode session',
        description: 'Creates a new agent session in Marcode and sends it an initial prompt. '
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
      const mcp = this.buildMcpServer();
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
