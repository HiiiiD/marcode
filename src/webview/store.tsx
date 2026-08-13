import {
  createContext, useContext, useEffect, useReducer, type ReactNode,
} from 'react';
import { initialState, reduce, type ClientState } from './reducer';
import { onHostMessage, postToHost } from './vscode-api';
import type { WebviewToHost } from '../protocol/messages';

interface StoreValue {
  state: ClientState;
  post: (msg: WebviewToHost) => void;
}

const StoreContext = createContext<StoreValue | undefined>(undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);

  useEffect(() => {
    const off = onHostMessage(dispatch);
    postToHost({ t: 'ready' });
    return off;
  }, []);

  return (
    <StoreContext.Provider value={{ state, post: postToHost }}>
      {children}
    </StoreContext.Provider>
  );
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) { throw new Error('useStore must be used inside StoreProvider'); }
  return value;
}
