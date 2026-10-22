import type { McpRow } from '../../client-core/mcp/mcp-rows';
import type { McpRemovableOrigin } from '../../protocol/messages';

export type McpListAction =
  | { t: 'move'; index: number }
  | { t: 'reconnect' | 'sign-in' | 'confirm-remove'; name: string }
  | { t: 'remove'; name: string; origin: McpRemovableOrigin }
  | { t: 'cancel' | 'add' | 'restart' | 'close' };

export interface McpListContext {
  rows: McpRow[];
  index: number;
  /** Name of the row whose delete is waiting for y/n. */
  confirming?: string;
  pending: boolean;
  canAdd: boolean;
}

/** `key` is the typed character for letters (so `R` is distinct from `r`), else the key name. */
export function mcpListKey(key: string, ctx: McpListContext): McpListAction | undefined {
  const row = ctx.rows[ctx.index];
  if (ctx.confirming !== undefined) {
    const target = ctx.rows.find((r) => r.name === ctx.confirming);
    if (key === 'y' && target?.removeOrigin) { return { t: 'remove', name: target.name, origin: target.removeOrigin }; }
    if (key === 'n' || key === 'escape') { return { t: 'cancel' }; }
    return undefined;
  }
  switch (key) {
    case 'escape': return { t: 'close' };
    case 'down': return { t: 'move', index: Math.min(Math.max(0, ctx.rows.length - 1), ctx.index + 1) };
    case 'up': return { t: 'move', index: Math.max(0, ctx.index - 1) };
    case 'r': return row?.canReconnect ? { t: 'reconnect', name: row.name } : undefined;
    case 's': return row?.canSignIn ? { t: 'sign-in', name: row.name } : undefined;
    case 'd': return row?.canRemove ? { t: 'confirm-remove', name: row.name } : undefined;
    case 'a': return ctx.canAdd ? { t: 'add' } : undefined;
    case 'R': return ctx.pending ? { t: 'restart' } : undefined;
    default: return undefined;
  }
}
