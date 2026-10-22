import type { McpPanel, SessionId, WebviewToHost } from '../../protocol/messages';
import type { AgentProvider, McpLocation, McpScope, McpTarget } from '../../providers/types';
import { withTimeout } from '../../shared/with-timeout';
import type { AgentSession } from '../agent-session';
import { validateSpec } from '../../client-core/mcp/validate-spec';
import { McpChangeLog } from './change-log';
import { resolveRepoRoot } from './repo-root';

export type McpMessage = Extract<WebviewToHost, {
  t: 'mcp-open' | 'mcp-add' | 'mcp-remove' | 'mcp-reconnect' | 'mcp-sign-in' | 'restart-session';
}>;

export interface McpServiceHost {
  get(id: SessionId): AgentSession | undefined;
  mcpContext(id: SessionId): { cwd: string; provider: AgentProvider } | undefined;
  isForeign(id: SessionId): boolean;
  restart(id: SessionId): Promise<void>;
}

const EMPTY: McpPanel = { capabilities: null, targets: null, pending: [], restarting: false };
const FOREIGN = 'This session is open in another window.';

/** Routes `/mcp` actions to the session's provider and answers with an `McpPanel`. Errors are state. */
export class McpService {
  private readonly errors = new Map<SessionId, string>();
  private readonly restarting = new Set<SessionId>();

  constructor(
    private readonly host: McpServiceHost,
    private readonly log = new McpChangeLog(),
    private readonly statusTimeoutMs = 8000,
    private readonly repoRoot: (cwd: string) => Promise<string> = resolveRepoRoot,
  ) {}

  async handle(msg: McpMessage, openExternal: (url: string) => void, interim?: (panel: McpPanel) => void): Promise<McpPanel> {
    const ctx = this.host.mcpContext(msg.id);
    if (!ctx) { return EMPTY; }
    const at: McpLocation = { cwd: ctx.cwd, repoRoot: await this.repoRoot(ctx.cwd) };
    try {
      await this.act(msg, ctx.provider, at, openExternal, interim);
      this.errors.delete(msg.id);
    } catch (err) {
      this.errors.set(msg.id, err instanceof Error ? err.message : String(err));
    }
    return this.panel(msg.id, ctx.provider, at);
  }

  private async act(
    msg: McpMessage, provider: AgentProvider, at: McpLocation,
    openExternal: (url: string) => void, interim?: (panel: McpPanel) => void,
  ): Promise<void> {
    const session = this.host.get(msg.id);
    const store = provider.mcpConfig;
    switch (msg.t) {
      case 'mcp-open':
        await this.refresh(session);
        return;
      case 'mcp-add': {
        if (this.host.isForeign(msg.id)) { throw new Error(FOREIGN); }
        if (!store) { throw new Error("This provider can't manage MCP servers from Marcode."); }
        // Clients validate too, but a daemon client is not trusted to, and the name reaches TOML headers and key paths.
        const invalid = validateSpec(msg.server, []);
        if (invalid) { throw new Error(invalid); }
        const file = await store.add(at, msg.scope, msg.server);
        this.log.record(file, msg.server.name, msg.scope, 'added');
        return;
      }
      case 'mcp-remove': {
        if (this.host.isForeign(msg.id)) { throw new Error(FOREIGN); }
        if (!store) { throw new Error("This provider can't manage MCP servers from Marcode."); }
        const file = await store.remove(at, msg.origin, msg.name);
        this.log.record(msg.origin === 'repo-private' ? `${file}#${at.repoRoot}` : file, msg.name, msg.origin, 'removed');
        return;
      }
      case 'mcp-reconnect':
        if (store?.capabilities.reconnect === 'restart') {
          await this.restart(msg.id, provider, at, interim);
          return;
        }
        if (!session?.mcp?.reconnect) { throw new Error("This session can't reconnect servers."); }
        await session.mcp.reconnect(msg.name);
        await this.refresh(session);
        return;
      case 'mcp-sign-in': {
        if (!session?.mcp?.signIn) { throw new Error("This provider can't sign in to MCP servers from Marcode."); }
        openExternal(await session.mcp.signIn(msg.name));
        return;
      }
      case 'restart-session':
        await this.restart(msg.id, provider, at, interim);
        return;
    }
  }

  private async restart(id: SessionId, provider: AgentProvider, at: McpLocation, interim?: (panel: McpPanel) => void): Promise<void> {
    if (this.restarting.has(id)) { throw new Error('This session is already restarting.'); }
    this.restarting.add(id);
    try {
      interim?.(await this.panel(id, provider, at));
      await this.host.restart(id);
    } finally {
      this.restarting.delete(id);
    }
    await this.refresh(this.host.get(id));
  }

  private async refresh(session: AgentSession | undefined): Promise<void> {
    if (!session?.mcp) { return; }
    session.setMcpServers(await withTimeout(session.mcp.status(), this.statusTimeoutMs, 'MCP status did not answer in time.'));
  }

  private async panel(id: SessionId, provider: AgentProvider, at: McpLocation): Promise<McpPanel> {
    const store = provider.mcpConfig;
    let targets: Record<McpScope, McpTarget> | null = null;
    if (store) {
      try { targets = await store.targets(at); } catch { targets = null; }
    }
    const keys = targets ? Object.values(targets).flatMap((t) => ('path' in t ? [t.path, `${t.path}#${at.repoRoot}`] : [])) : [];
    const error = this.errors.get(id);
    const foreign = this.host.isForeign(id);
    return {
      capabilities: store && !foreign ? { ...store.capabilities } : null,
      ...(foreign ? { readOnly: FOREIGN } : {}),
      targets,
      pending: this.log.pendingFor(keys, this.host.get(id)?.configLoadedAt()),
      restarting: this.restarting.has(id),
      ...(error !== undefined ? { error } : {}),
    };
  }
}
