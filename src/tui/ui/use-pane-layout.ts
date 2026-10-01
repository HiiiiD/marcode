import { useCallback, useEffect, useRef } from 'react';
import {
  findPath, leafSessionIds, placeSession, removeSession, rootOrientation, type LayoutNode,
} from '../../client-core/layout-tree';
import { reconcilePaneLayout, rosterSessionIds } from '../../client-core/pane-layout';
import { splitAtSession } from '../../client-core/pane-ops';
import type { PaneLayout, SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';

export interface PaneLayoutApi {
  root: LayoutNode;
  leafIds: SessionId[];
  placeOrFocus(id: SessionId): void;
  hide(id: SessionId): void;
  /** The next unseen session splits the focused pane instead of taking the first free slot; `null` disarms. */
  armSplit(orientation: 'horizontal' | 'vertical' | null): void;
  applyRoot(root: LayoutNode): void;
  /** The next unseen session was asked for by the user, so it takes focus. */
  expectArrival(): void;
}

export function usePaneLayout(): PaneLayoutApi {
  const { state, post, focus, focusedId, setLocalLayout } = useTuiStore();
  const root = state.layout.root;
  const leafIds = leafSessionIds(root);
  const stateRef = useRef(state);
  stateRef.current = state;
  const known = useRef<Set<string>>(new Set());
  const split = useRef<'horizontal' | 'vertical' | null>(null);
  const expecting = useRef(false);

  const applyRoot = useCallback((next: LayoutNode) => {
    const layout: PaneLayout = { ...stateRef.current.layout, root: next };
    post({ t: 'set-layout', layout });
    setLocalLayout(layout);
  }, [post, setLocalLayout]);

  const byIdKeys = Object.keys(state.byId);
  useEffect(() => {
    const cur = stateRef.current;
    const roster = rosterSessionIds(cur.sessions);
    const before = known.current;
    const arrived = byIdKeys.filter((id) => roster.has(id) && !before.has(id) && !leafIds.includes(id));
    if (split.current && arrived.length === 1) {
      known.current = new Set([...before, ...byIdKeys]);
      applyRoot(splitAtSession(cur.layout.root, cur.focusedSessionId, split.current, arrived[0]));
      split.current = null;
    } else {
      const result = reconcilePaneLayout(
        cur.layout.root, roster, byIdKeys, before, cur.focusedSessionId ?? cur.layout.focusedSessionId,
      );
      known.current = result.knownSessionIds;
      if (result.root) { applyRoot(result.root); }
    }
    if (expecting.current && arrived.length > 0) { expecting.current = false; focus(arrived[0]); }
  }, [byIdKeys.join(','), state.sessions.map((s) => s.id).join(','), leafIds.join(',')]);

  useEffect(() => { post({ t: 'set-visible', sessionIds: leafIds }); }, [leafIds.join(',')]);

  const placeOrFocus = useCallback((id: SessionId) => {
    const cur = stateRef.current;
    if (findPath(cur.layout.root, id) === undefined) {
      applyRoot(placeSession(cur.layout.root, id, cur.focusedSessionId, rootOrientation(cur.layout.root)));
    }
    focus(id);
  }, [applyRoot, focus]);

  return {
    root, leafIds, placeOrFocus, applyRoot,
    hide: (id) => { applyRoot(removeSession(stateRef.current.layout.root, id)); },
    armSplit: (o) => { split.current = o; },
    expectArrival: () => { expecting.current = true; },
  };
}
