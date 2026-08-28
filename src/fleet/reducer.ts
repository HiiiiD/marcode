import type { HostToWebview, SessionSummary } from '../protocol/messages';

/**
 * Everything the fleet tab knows: the roster and whether it has ever heard
 * from the host. Narrow on purpose, same reasoning as `ReviewState` — this
 * client subscribes to no message it cannot represent here.
 */
export interface FleetState {
  ready: boolean;
  sessions: SessionSummary[];
}

export const initialFleetState: FleetState = { ready: false, sessions: [] };

export function reduceFleet(state: FleetState, msg: HostToWebview): FleetState {
  switch (msg.t) {
    case 'hydrate':
      return { ...state, ready: true, sessions: msg.sessions };

    case 'sessions-changed':
      return { ...state, sessions: msg.sessions };

    case 'session-status':
      return {
        ...state,
        sessions: state.sessions.map((s) => (s.id === msg.id ? { ...s, status: msg.status } : s)),
      };

    // Anything else is a message this client never subscribed to.
    default:
      return state;
  }
}
