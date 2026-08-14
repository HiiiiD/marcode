// Pure rollup helpers for the roster's MCP group — no React, no UI imports,
// so the mocha unit harness requires them directly.
import type { McpServerStatus, SessionId } from '../../protocol/messages';

/**
 * Severity order, worst last.
 *
 * `disabled` ranks below `connected`: a server the user turned off is not a
 * problem, and colouring it like one trains people to ignore the signal.
 */
const RANK: Record<McpServerStatus['state'], number> = {
  disabled: 0,
  connected: 1,
  pending: 2,
  'needs-auth': 3,
  failed: 4,
};

export function worstState(
  servers: McpServerStatus[],
): McpServerStatus['state'] | undefined {
  let worst: McpServerStatus['state'] | undefined;
  for (const server of servers) {
    if (worst === undefined || RANK[server.state] > RANK[worst]) { worst = server.state; }
  }
  return worst;
}

/**
 * Worth interrupting the roster trigger for.
 *
 * `pending` is excluded deliberately: every server is pending for the first
 * moment of every session, and a warning that always fires at startup is a
 * warning nobody reads.
 */
export function isUnhealthy(state: McpServerStatus['state']): boolean {
  return state === 'failed' || state === 'needs-auth';
}

/**
 * One list across every pane currently in the split, deduped by server name.
 *
 * Sessions share the workspace's MCP configuration, so the same server
 * appearing under two sessions is one server. When two sessions disagree,
 * the worse report wins — a server that failed for one session is a real
 * problem even if another session got it up. Fields the worse report lacks
 * (a tool count it never learned because it never connected) are carried
 * over from the better one.
 *
 * Only panes appear here because status only flows for visible sessions;
 * the roster labels the group accordingly rather than implying it has
 * surveyed sessions it has never opened.
 */
export function aggregateServers(
  byId: Record<SessionId, { mcpServers: McpServerStatus[] }>,
): McpServerStatus[] {
  const merged = new Map<string, McpServerStatus>();
  for (const pane of Object.values(byId)) {
    for (const server of pane.mcpServers ?? []) {
      const existing = merged.get(server.name);
      if (!existing) { merged.set(server.name, { ...server }); continue; }
      const worse = RANK[server.state] > RANK[existing.state] ? server : existing;
      const other = worse === server ? existing : server;
      merged.set(server.name, {
        ...worse,
        toolCount: worse.toolCount ?? other.toolCount,
        error: worse.error ?? other.error,
      });
    }
  }
  return [...merged.values()].sort(
    (a, b) => RANK[b.state] - RANK[a.state] || a.name.localeCompare(b.name),
  );
}
