import type { SessionId, SessionStatus, SessionSummary } from '../../protocol/messages';

export interface RosterRow {
  id: SessionId; title: string; glyph: '●' | '○' | '!' | '✗';
  suffix?: string; dim: boolean; focused: boolean; pinned: boolean; foreign: boolean; leaf: boolean; squeezed: boolean;
}

const GLYPH: Record<SessionStatus, RosterRow['glyph']> = {
  running: '●', idle: '○', 'awaiting-approval': '!', error: '✗',
};

export const statusGlyph = (status: SessionStatus): RosterRow['glyph'] => GLYPH[status];

export function rosterRows(sessions: SessionSummary[], focusedId: SessionId | null, filter = '', leafIds: ReadonlySet<SessionId> = new Set(),
  squeezedIds: ReadonlySet<SessionId> = new Set()): RosterRow[] {
  const needle = filter.toLowerCase();
  const rows = sessions
    .map((s): RosterRow => ({
      id: s.id,
      title: s.name || s.title,
      glyph: GLYPH[s.status],
      ...(s.owner ? { suffix: `${s.owner.host}·${s.owner.pid}` } : {}),
      dim: s.owner !== undefined,
      focused: s.id === focusedId,
      pinned: s.pinned === true,
      foreign: s.owner !== undefined,
      leaf: leafIds.has(s.id),
      squeezed: squeezedIds.has(s.id),
    }))
    .filter((row) => needle === '' || row.title.toLowerCase().includes(needle));
  return [...rows.filter((r) => r.pinned), ...rows.filter((r) => !r.pinned)];
}
