import type { SessionId, SessionStatus, SessionSummary } from '../../protocol/messages';

export interface RosterRow {
  id: SessionId; title: string; glyph: '●' | '○' | '!' | '✗';
  suffix?: string; dim: boolean; focused: boolean;
}

const GLYPH: Record<SessionStatus, RosterRow['glyph']> = {
  running: '●', idle: '○', 'awaiting-approval': '!', error: '✗',
};

export function rosterRows(sessions: SessionSummary[], focusedId: SessionId | null): RosterRow[] {
  return sessions.map((s) => ({
    id: s.id,
    title: s.name || s.title,
    glyph: GLYPH[s.status],
    ...(s.owner ? { suffix: `${s.owner.host}·${s.owner.pid}` } : {}),
    dim: s.owner !== undefined,
    focused: s.id === focusedId,
  }));
}
