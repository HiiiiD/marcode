import { redactSecrets } from '../redact';
import type { McpControl, McpOrigin, McpServerStatus } from '../types';
import type { CodexRequest, ConfigReadLike } from './mcp-config';

interface ListedServer {
  name: string;
  runtimeStatus?: string | null;
  toolsError?: string | null;
  tools?: Record<string, unknown>;
  authStatus?: string;
}
interface ListResponse { data?: ListedServer[]; nextCursor?: string | null }

const RUNTIME: Record<string, McpServerStatus['state']> = {
  ready: 'connected', starting: 'pending', failed: 'failed', cancelled: 'disabled',
};
const LAYER_ORIGIN: Record<string, McpOrigin> = { project: 'repo', user: 'global' };

export function codexMcpControl(deps: {
  request: CodexRequest;
  cwd: string;
  threadId: () => string | undefined;
  /** The per-server startup notifications the run has already merged. */
  startupState: (name: string) => McpServerStatus['state'] | undefined;
}): McpControl {
  const origins = async (): Promise<Map<string, { origin: McpOrigin; label?: string }>> => {
    const out = new Map<string, { origin: McpOrigin; label?: string }>();
    const read = await deps.request<ConfigReadLike>('config/read', { includeLayers: true, cwd: deps.cwd }).catch(() => ({} as ConfigReadLike));
    // Highest-precedence layer first, so the first one naming a server is where it is defined.
    for (const layer of read.layers ?? []) {
      const type = layer.name?.type ?? 'other';
      for (const name of Object.keys(layer.config?.mcp_servers ?? {})) {
        if (!out.has(name)) { out.set(name, { origin: LAYER_ORIGIN[type] ?? 'other', ...(LAYER_ORIGIN[type] ? {} : { label: type }) }); }
      }
    }
    return out;
  };

  return {
    status: async () => {
      const listed: ListedServer[] = [];
      let cursor: string | null | undefined;
      do {
        const threadId = deps.threadId();
        const page = await deps.request<ListResponse>('mcpServerStatus/list', {
          detail: 'full', ...(threadId ? { threadId } : {}), ...(cursor ? { cursor } : {}),
        });
        listed.push(...(page.data ?? []));
        cursor = page.nextCursor;
      } while (cursor);
      const where = await origins();
      return listed
        .filter((s) => s.name !== 'marcode_self_control')
        .map((s): McpServerStatus => {
          const needsAuth = s.authStatus === 'notLoggedIn';
          const state = needsAuth ? 'needs-auth'
            : (s.runtimeStatus ? RUNTIME[s.runtimeStatus] : undefined) ?? deps.startupState(s.name) ?? 'pending';
          const at = where.get(s.name);
          return {
            name: s.name,
            state,
            ...(s.toolsError && state === 'failed' ? { error: redactSecrets(s.toolsError.split('\n')[0]) } : {}),
            toolCount: Object.keys(s.tools ?? {}).length,
            ...(at ? { origin: at.origin } : {}),
            ...(at?.label ? { originLabel: at.label } : {}),
            canSignIn: needsAuth,
          };
        });
    },
    signIn: async (name) => {
      const threadId = deps.threadId();
      const res = await deps.request<{ authorizationUrl?: string }>('mcpServer/oauth/login', { name, ...(threadId ? { threadId } : {}) });
      if (!res.authorizationUrl) { throw new Error(`Codex gave no sign-in link for ${name}.`); }
      return res.authorizationUrl;
    },
  };
}
