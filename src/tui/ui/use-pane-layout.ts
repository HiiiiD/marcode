import { useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useRef } from 'react';
import { placeSessionAuto, rearrange, type AutoGridOptions } from '../../client-core/auto-grid';
import {
  findPath, leafSessionIds, removeSession, rootOrientation, type LayoutNode,
} from '../../client-core/layout-tree';
import { reconcilePaneLayout, rosterSessionIds } from '../../client-core/pane-layout';
import { splitAtSession } from '../../client-core/pane-ops';
import type { PaneLayout, SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';

// An arm older than this was for a session the host never produced; whatever arrives later is not it.
const ARM_MS = 15_000;
// A cell is about twice as tall as wide, so heights are doubled to compare like with like against the pixel-shaped scoring.
const CELL_ASPECT = 2;
const MIN_PANE = { width: 40, height: 10 * CELL_ASPECT };
export const REARRANGE_NOTICE = 'Layout is custom — ^W a rearranges it into a grid';

export interface PaneLayoutApi {
  root: LayoutNode;
  leafIds: SessionId[];
  placeOrFocus(id: SessionId): void;
  hide(id: SessionId): void;
  /** The next unseen session splits the focused pane instead of taking the first free slot; `null` disarms. */
  armSplit(orientation: 'horizontal' | 'vertical' | null): void;
  splitArmed(): boolean;
  applyRoot(root: LayoutNode): void;
  /** The next unseen session was asked for by the user, so it takes focus. */
  expectArrival(): void;
  /** Regrids every pane in reading order and withdraws the offer. */
  rearrangeNow(): void;
}

export function usePaneLayout(): PaneLayoutApi {
  const { state, post, focus, focusedId, setLocalLayout, setNotice } = useTuiStore();
  const { width, height } = useTerminalDimensions();
  const stateRef = useRef(state);
  stateRef.current = state;
  const autoGrid = (): AutoGridOptions => ({
    enabled: stateRef.current.autoGrid,
    viewport: { width, height: height * CELL_ASPECT },
    minPane: MIN_PANE,
  });
  const root = state.layout.root;
  const leafIds = leafSessionIds(root);
  const known = useRef<Set<string>>(new Set());
  const split = useRef<{ orientation: 'horizontal' | 'vertical'; until: number } | null>(null);
  const expecting = useRef<number | null>(null);

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
    const armedSplit = split.current && split.current.until > Date.now() ? split.current.orientation : null;
    if (armedSplit && arrived.length === 1) {
      known.current = new Set([...before, ...byIdKeys]);
      applyRoot(splitAtSession(cur.layout.root, cur.focusedSessionId, armedSplit, arrived[0]));
      split.current = null;
    } else {
      const result = reconcilePaneLayout(
        cur.layout.root, roster, byIdKeys, before, cur.focusedSessionId ?? cur.layout.focusedSessionId, autoGrid(),
      );
      known.current = result.knownSessionIds;
      if (result.offerRearrange) { setNotice(REARRANGE_NOTICE); }
      if (result.root) { applyRoot(result.root); }
    }
    if (arrived.length > 0) {
      const wanted = expecting.current !== null && expecting.current > Date.now();
      expecting.current = null;
      split.current = null;
      if (wanted) { focus(arrived[0]); }
    }
  }, [byIdKeys.join(','), state.sessions.map((s) => s.id).join(','), leafIds.join(',')]);

  // Before hydrate the layout is a placeholder; posting it would hide every pane a daemon still shows.
  useEffect(() => { if (state.ready) { post({ t: 'set-visible', sessionIds: leafIds }); } }, [state.ready, leafIds.join(',')]);

  const placeOrFocus = useCallback((id: SessionId) => {
    const cur = stateRef.current;
    if (findPath(cur.layout.root, id) === undefined) {
      const placed = placeSessionAuto(cur.layout.root, id, cur.focusedSessionId, rootOrientation(cur.layout.root), autoGrid());
      applyRoot(placed.root);
      if (placed.offerRearrange) { setNotice(REARRANGE_NOTICE); }
    }
    focus(id);
  }, [applyRoot, focus]);

  const rearrangeNow = useCallback(() => {
    const { viewport, minPane } = autoGrid();
    applyRoot(rearrange(stateRef.current.layout.root, viewport, minPane));
    setNotice(null);
  }, [applyRoot, width, height, setNotice]);

  return {
    root, leafIds, placeOrFocus, applyRoot, rearrangeNow,
    hide: (id) => { applyRoot(removeSession(stateRef.current.layout.root, id)); },
    armSplit: (o) => { split.current = o ? { orientation: o, until: Date.now() + ARM_MS } : null; },
    splitArmed: () => split.current !== null && split.current.until > Date.now(),
    expectArrival: () => { expecting.current = Date.now() + ARM_MS; },
  };
}
