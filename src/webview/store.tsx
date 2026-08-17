import {
  createContext, useCallback, useContext, useEffect, useReducer, type ReactNode,
} from 'react';
import { initialState, reduce, type ClientState } from './reducer';
import { onHostMessage, postToHost } from './vscode-api';
import type { SessionId, WebviewToHost } from '../protocol/messages';

interface StoreValue {
  state: ClientState;
  post: (msg: WebviewToHost) => void;
  /**
   * Record that the user is working in `id`. Client-local — nothing is
   * posted, because the host has no use for which pane has focus.
   */
  focus: (id: SessionId) => void;
  /**
   * Close `id`'s composer rejection line. Client-local for the same reason as
   * `focus`: the host emits a rejection and keeps nothing, so there is no
   * host state a dismissal could correct.
   */
  dismissRejection: (id: SessionId) => void;
}

const StoreContext = createContext<StoreValue | undefined>(undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);

  useEffect(() => {
    const off = onHostMessage(dispatch);
    postToHost({ t: 'ready' });
    return off;
  }, []);

  // Stable across renders, and that stability is load-bearing rather than an
  // optimization: `post` is a dependency of every "ask the host once" effect
  // in the panel (the pane header's worktree probe, the context dialog's
  // fetch), and a fresh identity on each render re-runs all of them on every
  // unrelated state change — one git subprocess per pane per keystroke-ish
  // re-render. `dispatch` is already stable, so there is nothing to close over
  // that can go stale.
  const post = useCallback((msg: WebviewToHost) => {
    postToHost(msg);
    // See the `local-layout` doc comment in reducer.ts: the host never
    // echoes `set-layout` back, so apply it here too or newly
    // opened/closed panes would never render until the next reload.
    if (msg.t === 'set-layout') {
      dispatch({ t: 'local-layout', layout: msg.layout });
    }
  }, []);

  const focus = (id: SessionId) => dispatch({ t: 'local-focus', id });
  const dismissRejection = (id: SessionId) => dispatch({ t: 'local-dismiss-rejection', id });

  return (
    <StoreContext.Provider value={{ state, post, focus, dismissRejection }}>
      {children}
    </StoreContext.Provider>
  );
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) { throw new Error('useStore must be used inside StoreProvider'); }
  return value;
}
