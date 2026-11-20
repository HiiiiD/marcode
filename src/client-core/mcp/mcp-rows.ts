import type { McpPanel, McpRemovableOrigin, McpServerStatus } from '../../protocol/messages';

export interface McpRow {
  name: string;
  state: McpServerStatus['state'];
  badge: string;
  detail: string;
  canReconnect: boolean;
  canRemove: boolean;
  canSignIn: boolean;
  /** Which section lists it: 'repo' (shared with repo-private), 'global', or an origin label like 'plugin'. */
  group: string;
  /** Defined in the per-project block of the user's own config, not in a file the repo shares. */
  private?: boolean;
  removeOrigin?: McpRemovableOrigin;
  /** The session is restarting: the row is pending and nothing on it can be acted on. */
  busy?: boolean;
}

const SELF_CONTROL = 'marcode_self_control';
const RANK: Record<McpServerStatus['state'], number> = { failed: 0, 'needs-auth': 1, pending: 2, connected: 3, disabled: 4 };

function badgeOf(s: McpServerStatus): string {
  switch (s.origin) {
    case 'repo': return 'repo';
    case 'global': return 'global';
    case 'repo-private': return 'repo · private';
    case 'other': return s.originLabel ?? 'other';
    default: return '';
  }
}

function groupOf(s: McpServerStatus): string {
  switch (s.origin) {
    case 'repo': case 'repo-private': return 'repo';
    case 'global': return 'global';
    case 'other': return s.originLabel ?? 'other';
    default: return 'other';
  }
}

function detailOf(s: McpServerStatus): string {
  if (s.state === 'failed') { return s.error ?? 'failed'; }
  if (s.state === 'needs-auth') { return 'needs sign-in'; }
  if (s.state === 'disabled') { return 'disabled'; }
  if (s.state === 'connected' && s.toolCount !== undefined) { return `${s.toolCount} ${s.toolCount === 1 ? 'tool' : 'tools'}`; }
  return '';
}

export function mcpRows(servers: McpServerStatus[], panel: McpPanel | undefined): McpRow[] {
  const caps = panel?.capabilities ?? null;
  const pending = panel?.pending ?? [];
  const removed = new Set(pending.filter((p) => p.change === 'removed').map((p) => p.name));
  const listed = servers.filter((s) => s.name !== SELF_CONTROL);
  const added: McpServerStatus[] = pending
    .filter((p) => p.change === 'added' && !listed.some((s) => s.name === p.name))
    .map((p) => ({ name: p.name, state: 'pending', origin: p.origin }));

  return [...listed, ...added]
    .sort((a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name))
    .map((s): McpRow => {
      if (panel?.restarting) {
        return { name: s.name, state: 'pending', badge: badgeOf(s), detail: 'restarting…', canReconnect: false, canRemove: false, canSignIn: false, group: groupOf(s), ...(s.origin === 'repo-private' ? { private: true } : {}), busy: true };
      }
      const isAdded = added.includes(s);
      const isRemoved = removed.has(s.name);
      const removable = caps !== null && s.origin !== undefined && s.origin !== 'other' && !isRemoved;
      return {
        name: s.name,
        state: s.state,
        badge: badgeOf(s),
        detail: isAdded ? 'added · restart to load' : isRemoved ? 'removed · restart to unload' : detailOf(s),
        canReconnect: caps !== null && !isAdded,
        canRemove: removable,
        canSignIn: Boolean(caps?.signIn && s.canSignIn && s.state === 'needs-auth'),
        group: groupOf(s),
        ...(s.origin === 'repo-private' ? { private: true } : {}),
        ...(removable ? { removeOrigin: s.origin as McpRemovableOrigin } : {}),
      };
    });
}

export function mcpSummary(rows: McpRow[]): string {
  if (rows.length === 0) { return 'No servers'; }
  const failing = rows.filter((r) => r.state === 'failed').length;
  const count = `${rows.length} ${rows.length === 1 ? 'server' : 'servers'}`;
  return failing > 0 ? `${count} · ${failing} failing` : count;
}

export interface McpGroup { key: string; rows: McpRow[] }

/** Repo first, then global, then whatever else (plugins, managed), keeping each group's own order. */
export function groupRows(rows: McpRow[]): McpGroup[] {
  const order = ['repo', 'global'];
  const keys = [...new Set(rows.map((r) => r.group))].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
  });
  return keys.map((key) => ({ key, rows: rows.filter((r) => r.group === key) }));
}
