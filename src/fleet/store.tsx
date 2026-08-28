import {
  createContext, useCallback, useContext, useEffect, useReducer, type ReactNode,
} from 'react';
import { initialFleetState, reduceFleet, type FleetState } from './reducer';
import { onHostMessage, postToHost } from '@/vscode-api';
import type { WebviewToHost } from '../protocol/messages';

interface StoreValue {
  state: FleetState;
  post: (msg: WebviewToHost) => void;
}

const StoreContext = createContext<StoreValue | undefined>(undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceFleet, initialFleetState);

  useEffect(() => {
    const off = onHostMessage(dispatch);
    postToHost({ t: 'ready' });
    return off;
  }, []);

  // Stable identity, and that stability is load-bearing: `post` is a
  // dependency of the surface's "ask once" and debounced-refresh effects, and
  // a fresh identity each render would re-run them — one git invocation per
  // tree per unrelated re-render.
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
