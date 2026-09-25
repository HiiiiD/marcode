import type { HostToWebview, SessionSummary } from '../protocol/messages';

export interface MemoryStatus { enabled: boolean; llm: boolean }
export interface MemoryEstimate { scope: 'all' | 'missing-llm'; sessions: number; approxInputTokens: number }
export interface MemoryProgress { phase: 'extractive' | 'llm'; done: number; total: number }

/** Narrow on purpose: no panes, no transcripts — see `HISTORY_WANTS`. */
export interface HistoryState {
  ready: boolean;
  sessions: SessionSummary[];
  memory?: MemoryStatus;
  estimate?: MemoryEstimate;
  progress?: MemoryProgress;
}

export const initialHistoryState: HistoryState = { ready: false, sessions: [] };

export function reduceHistory(state: HistoryState, msg: HostToWebview): HistoryState {
  switch (msg.t) {
    case 'hydrate': return { ...state, ready: true, sessions: msg.sessions };
    case 'sessions-changed': return { ...state, sessions: msg.sessions };
    case 'memory-status': return { ...state, memory: { enabled: msg.enabled, llm: msg.llm } };
    case 'memory-estimate': {
      const { scope, sessions, approxInputTokens } = msg;
      return { ...state, estimate: { scope, sessions, approxInputTokens } };
    }
    case 'memory-progress':
      if (msg.phase === 'done' || msg.phase === 'cancelled') {
        return { ...state, estimate: undefined, progress: undefined };
      }
      return { ...state, estimate: undefined, progress: { phase: msg.phase, done: msg.done, total: msg.total } };
    default: return state;
  }
}
