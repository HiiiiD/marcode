import {
  createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode,
} from 'react';
import { initialState, reduce, type ClientState } from './reducer';
import { createDraftStore, type DraftStore } from './lib/draft-store';
import { vscodeTransport } from './vscode-transport';
import type { SessionId, WebviewToHost } from '../protocol/messages';

interface StoreActions {
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
  /** See `ClientState.pendingSlotPath`. */
  setPendingSlot: (path: number[] | null) => void;
  dismissRearrange: () => void;
}

interface StoreValue extends StoreActions {
  state: ClientState;
}

const StoreContext = createContext<StoreValue | undefined>(undefined);

/**
 * Split from `StoreContext` so a component that only posts (markdown links,
 * tool cards) does not re-render on every state change. Its value is stable
 * for the provider's lifetime.
 */
const ActionsContext = createContext<StoreActions | undefined>(undefined);

/**
 * Separate from `StoreContext` on purpose: `DraftStore` notifies per-session
 * subscribers directly (see `lib/draft-store.ts`), so a keystroke in one
 * pane's composer never touches this context's value and never re-renders
 * `StoreContext`'s consumers. Kept in its own context (rather than a module
 * singleton) so each `StoreProvider` — the DOM test harness mounts a fresh
 * one per test — gets its own store.
 */
const DraftStoreContext = createContext<DraftStore | undefined>(undefined);

export function useDraftStore(): DraftStore {
  const value = useContext(DraftStoreContext);
  if (!value) { throw new Error('useDraftStore must be used inside StoreProvider'); }
  return value;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  // One instance per provider (not a module singleton), created once on
  // first render — see the `DraftStoreContext` doc comment above.
  const draftStoreRef = useRef<DraftStore | undefined>(undefined);
  if (!draftStoreRef.current) { draftStoreRef.current = createDraftStore(); }
  const draftStore = draftStoreRef.current;

  useEffect(() => {
    const off = vscodeTransport.onMessage((msg) => {
      // Seeded here, not through `reduce`: a draft no longer lives in
      // `ClientState` (see `lib/draft-store.ts`), so hydrate's copy has to
      // reach the draft store directly.
      if (msg.t === 'hydrate') {
        draftStore.hydrate(
          msg.sessions.filter((s): s is typeof s & { draft: string } => s.draft !== undefined)
            .map((s) => [s.id, s.draft]),
        );
      }
      dispatch(msg);
    });
    vscodeTransport.post({ t: 'ready' });
    return off;
  }, [draftStore]);

  // Stable across renders, and that stability is load-bearing rather than an
  // optimization: `post` is a dependency of every "ask the host once" effect
  // in the panel (the pane header's worktree probe, the context dialog's
  // fetch), and a fresh identity on each render re-runs all of them on every
  // unrelated state change — one git subprocess per pane per keystroke-ish
  // re-render. `dispatch` is already stable, so there is nothing to close over
  // that can go stale.
  const post = useCallback((msg: WebviewToHost) => {
    vscodeTransport.post(msg);
    // See the `local-layout` doc comment in reducer.ts: the host never
    // echoes `set-layout` back, so apply it here too or newly
    // opened/closed panes would never render until the next reload.
    if (msg.t === 'set-layout') {
      dispatch({ t: 'local-layout', layout: msg.layout });
    }
    // Same reasoning: nothing echoes the click itself, only its eventual
    // usage-refresh-done — so the spinner has to start optimistically here
    // or it would never render for however long the round takes.
    if (msg.t === 'refresh-usage') {
      dispatch({ t: 'local-usage-refresh-start' });
    }
  }, []);

  const actions = useMemo<StoreActions>(() => ({
    post,
    focus: (id) => {
      dispatch({ t: 'local-focus', id });
      vscodeTransport.post({ t: 'focus-pane', sessionId: id });
    },
    dismissRejection: (id) => dispatch({ t: 'local-dismiss-rejection', id }),
    setPendingSlot: (path) => dispatch({ t: 'local-pending-slot', path }),
    dismissRearrange: () => dispatch({ t: 'local-dismiss-rearrange' }),
  }), [post]);
  const value = useMemo<StoreValue>(() => ({ state, ...actions }), [state, actions]);

  return (
    <ActionsContext.Provider value={actions}>
      <StoreContext.Provider value={value}>
        <DraftStoreContext.Provider value={draftStore}>
          {children}
        </DraftStoreContext.Provider>
      </StoreContext.Provider>
    </ActionsContext.Provider>
  );
}

export function useActions(): StoreActions {
  const value = useContext(ActionsContext);
  if (!value) { throw new Error('useActions must be used inside StoreProvider'); }
  return value;
}

export function usePost(): StoreActions['post'] {
  return useActions().post;
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) { throw new Error('useStore must be used inside StoreProvider'); }
  return value;
}
