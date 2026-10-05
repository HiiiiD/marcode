import {
  createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode,
} from 'react';
import { createDraftStore, type DraftStore } from '../../client-core/draft-store';
import { initialState, reduce, type ClientState } from '../../client-core/reducer';
import type { ClientTransport } from '../../client-core/transport';
import type { PaneLayout, SessionId, WebviewToHost } from '../../protocol/messages';

export interface TuiStoreValue {
  state: ClientState;
  post(msg: WebviewToHost): void;
  drafts: DraftStore;
  focusedId: SessionId | null;
  focus(id: SessionId): void;
  setLocalLayout(layout: PaneLayout): void;
  /** True between Ctrl+W and its second key, so listeners registered before the chord hook can stand down. */
  chordArmed: { current: boolean };
  notice: string | null;
  setNotice(text: string | null): void;
  mentionOpen: boolean;
  setMentionOpen(open: boolean): void;
  rosterFiltering: boolean;
  setRosterFiltering(on: boolean): void;
  /** Pulls plan usage again; a no-op while a round is already in flight. */
  refreshUsage(): void;
  dismissRejection(id: SessionId): void;
}

const Ctx = createContext<TuiStoreValue | undefined>(undefined);

export function TuiStoreProvider({ transport, children }: { transport: ClientTransport; children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [notice, setNotice] = useState<string | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [rosterFiltering, setRosterFiltering] = useState(false);
  const chordArmed = useRef(false);
  const draftsRef = useRef<DraftStore | undefined>(undefined);
  if (!draftsRef.current) { draftsRef.current = createDraftStore(); }
  const drafts = draftsRef.current;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const off = transport.onMessage((msg) => {
      if (msg.t === 'hydrate') {
        drafts.hydrate(
          msg.sessions.filter((s): s is typeof s & { draft: string } => s.draft !== undefined).map((s) => [s.id, s.draft]),
        );
      }
      dispatch(msg);
    });
    transport.post({ t: 'ready' });
    return off;
  }, [transport, drafts]);

  const post = useCallback((msg: WebviewToHost) => { transport.post(msg); }, [transport]);

  const focus = useCallback((id: SessionId) => {
    transport.post({ t: 'focus-pane', sessionId: id });
    dispatch({ t: 'local-focus', id });
  }, [transport]);

  const refreshUsage = useCallback(() => {
    if (stateRef.current.usageRefreshing) { return; }
    // Nothing echoes the request, only its eventual usage-refresh-done, so the marker has to start here.
    stateRef.current = { ...stateRef.current, usageRefreshing: true };
    transport.post({ t: 'refresh-usage' });
    dispatch({ t: 'local-usage-refresh-start' });
  }, [transport]);

  const setLocalLayout = useCallback((layout: PaneLayout) => { dispatch({ t: 'local-layout', layout }); }, []);

  const dismissRejection = useCallback((id: SessionId) => { dispatch({ t: 'local-dismiss-rejection', id }); }, []);

  const focusedId = state.focusedSessionId ?? null;
  const value = useMemo<TuiStoreValue>(
    () => ({ state, post, drafts, focusedId, focus, setLocalLayout, chordArmed, notice, setNotice, mentionOpen, setMentionOpen, rosterFiltering, setRosterFiltering, refreshUsage, dismissRejection }),
    [state, post, drafts, focusedId, focus, setLocalLayout, chordArmed, notice, mentionOpen, rosterFiltering, refreshUsage, dismissRejection],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTuiStore(): TuiStoreValue {
  const value = useContext(Ctx);
  if (!value) { throw new Error('useTuiStore must be used inside TuiStoreProvider'); }
  return value;
}
