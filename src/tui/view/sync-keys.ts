export type SyncRow =
  | { kind: 'device'; deviceId: string; self: boolean; revoked: boolean; unfinishedRevoke?: boolean }
  | { kind: 'project'; path: string; choice: 'shared' | 'own' | 'linked' | 'none' };

export type SyncConfirm = { t: 'revoke'; deviceId: string } | { t: 'leave' };

export type SyncKeyAction =
  | { t: 'move'; index: number }
  | { t: 'confirm'; what: SyncConfirm }
  | { t: 'revoke'; deviceId: string }
  | { t: 'leave' | 'cancel' | 'close' | 'pair' | 'refresh' }
  | { t: 'project'; path: string; choice: 'shared' | 'own' };

export interface SyncKeyContext { rows: SyncRow[]; index: number; busy: boolean; confirming?: SyncConfirm }

/** The paired view's keys. `key` is the typed character for letters, else the key name. */
export function syncKey(key: string, ctx: SyncKeyContext): SyncKeyAction | undefined {
  if (ctx.confirming) {
    if (key === 'y') { return ctx.confirming; }
    if (key === 'n' || key === 'escape') { return { t: 'cancel' }; }
    return undefined;
  }
  if (key === 'escape') { return { t: 'close' }; }
  if (key === 'down') { return { t: 'move', index: Math.min(Math.max(0, ctx.rows.length - 1), ctx.index + 1) }; }
  if (key === 'up') { return { t: 'move', index: Math.max(0, ctx.index - 1) }; }
  if (ctx.busy) { return undefined; }
  const row = ctx.rows[ctx.index];
  switch (key) {
    case 'p': return { t: 'pair' };
    case 'g': return { t: 'refresh' };
    case 'l': return { t: 'confirm', what: { t: 'leave' } };
    case 'r':
      if (row?.kind !== 'device' || row.self) { return undefined; }
      if (row.unfinishedRevoke) { return { t: 'revoke', deviceId: row.deviceId }; }
      return row.revoked ? undefined : { t: 'confirm', what: { t: 'revoke', deviceId: row.deviceId } };
    case 's':
    case 'k':
      return row?.kind === 'project' && row.choice !== 'none' ? { t: 'project', path: row.path, choice: key === 's' ? 'shared' : 'own' } : undefined;
    default:
      return undefined;
  }
}
