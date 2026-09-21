import {
  createContext, useCallback, useContext, useEffect, useReducer, type ReactNode,
} from 'react';
import { initialHistoryState, reduceHistory, type HistoryState } from './reducer';
import { onHostMessage, postToHost } from '@/vscode-api';
import type { WebviewToHost } from '../protocol/messages';

interface StoreValue {
  state: HistoryState;
  post: (msg: WebviewToHost) => void;
}

const StoreContext = createContext<StoreValue | undefined>(undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceHistory, initialHistoryState);

  useEffect(() => {
    const off = onHostMessage(dispatch);
    postToHost({ t: 'ready' });
    postToHost({ t: 'request-history-summaries' });
    return off;
  }, []);

  const post = useCallback((msg: WebviewToHost) => { postToHost(msg); }, []);

  return (
    <StoreContext.Provider value={{ state, post }}>{children}</StoreContext.Provider>
  );
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) { throw new Error('useStore must be used inside StoreProvider'); }
  return value;
}
