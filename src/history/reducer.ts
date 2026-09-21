import type { HostToWebview, SessionSummary } from '../protocol/messages';

/** Narrow on purpose: no panes, no transcripts — see `HISTORY_WANTS`. */
export interface HistoryState { ready: boolean; sessions: SessionSummary[] }

export const initialHistoryState: HistoryState = { ready: false, sessions: [] };

export function reduceHistory(state: HistoryState, msg: HostToWebview): HistoryState {
  switch (msg.t) {
    case 'hydrate': return { ready: true, sessions: msg.sessions };
    case 'sessions-changed': return { ...state, sessions: msg.sessions };
    default: return state;
  }
}
