import type { HostToWebview, SessionSummary, TreeDiff } from '../protocol/messages';

/**
 * Everything the review tab knows.
 *
 * Narrow on purpose. It has no `byId`, no layout and no composer, because it
 * subscribes to no message that carries them (see `REVIEW_WANTS`). The
 * narrowness is what makes the fan-out safe to reason about: a message the
 * client cannot represent is a message it must not have asked for.
 */
export interface ReviewState {
  ready: boolean;
  sessions: SessionSummary[];
  fleetDiff: TreeDiff[] | undefined;
  fleetDiffReason: string | undefined;
  /**
   * Bumped whenever something could have changed a diff. The surface debounces
   * a re-request off it rather than re-reading on every edit.
   */
  fleetDiffDirty: number;
  /**
   * Whether the review tab is on screen. A tab that has never reported was
   * just created and revealed, so the initial value is `true`.
   */
  visible: boolean;
}

export const initialReviewState: ReviewState = {
  ready: false,
  sessions: [],
  fleetDiff: undefined,
  fleetDiffReason: undefined,
  fleetDiffDirty: 0,
  visible: true,
};

export function reduceReview(state: ReviewState, msg: HostToWebview): ReviewState {
  switch (msg.t) {
    case 'hydrate':
      return { ...state, ready: true, sessions: msg.sessions };

    case 'sessions-changed':
      return { ...state, sessions: msg.sessions };

    // A session going idle is the moment its edits have settled. The panel's
    // reducer counts the same thing for the same reason.
    case 'session-status':
      return msg.status === 'idle'
        ? { ...state, fleetDiffDirty: state.fleetDiffDirty + 1 }
        : state;

    case 'fleet-diff':
      return { ...state, fleetDiff: msg.trees, fleetDiffReason: msg.reason };

    case 'review-visibility':
      return { ...state, visible: msg.visible };

    // Anything else is a message this client never subscribed to. Ignoring it
    // is the second layer behind REVIEW_WANTS, not a substitute for it.
    default:
      return state;
  }
}
