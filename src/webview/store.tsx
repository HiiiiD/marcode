import {
  createContext, useContext, useEffect, useReducer, type ReactNode,
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
}

const StoreContext = createContext<StoreValue | undefined>(undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);

  useEffect(() => {
    const off = onHostMessage(dispatch);
    postToHost({ t: 'ready' });
    return off;
  }, []);

  const post = (msg: WebviewToHost) => {
    postToHost(msg);
    // See the `local-layout` doc comment in reducer.ts: the host never
    // echoes `set-layout` back, so apply it here too or newly
    // opened/closed panes would never render until the next reload.
    if (msg.t === 'set-layout') {
      dispatch({ t: 'local-layout', layout: msg.layout });
    }
  };

  const focus = (id: SessionId) => dispatch({ t: 'local-focus', id });

  return (
    <StoreContext.Provider value={{ state, post, focus }}>
      {children}
    </StoreContext.Provider>
  );
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) { throw new Error('useStore must be used inside StoreProvider'); }
  return value;
}
