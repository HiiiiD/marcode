import type { McpPanel, McpRemovableOrigin, McpServerStatus } from '../../protocol/messages';

export interface McpRow {
  name: string;
  state: McpServerStatus['state'];
  badge: string;
  detail: string;
  canReconnect: boolean;
  canRemove: boolean;
  canSignIn: boolean;
  removeOrigin?: McpRemovableOrigin;
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

function detailOf(s: McpServerStatus): string {
  if (s.state === 'failed') { return s.error ?? 'failed'; }
  if (s.state === 'needs-auth') { return 'needs sign-in'; }
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
    .map((s) => {
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
