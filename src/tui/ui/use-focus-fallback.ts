import { useEffect, useRef, useState } from 'react';
import { leafSessionIds } from '../../client-core/layout-tree';
import type { SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';

/**
 * The host closes a session by removing it from the roster or emptying its leaf, and neither clears the
 * client's focus. This moves focus to the nearest remaining pane, else the next roster row (else the previous),
 * or abandons it so the empty state shows: a session the user just closed is never silently re-shown.
 */
export function useFocusFallback(
  placeOrFocus: (id: SessionId) => void,
): { shownId: SessionId | null; focusSession(id: SessionId): void } {
  const { state, focusedId } = useTuiStore();
  const [abandoned, setAbandoned] = useState<SessionId | null>(null);
  const prev = useRef<{ order: SessionId[]; leaves: SessionId[] }>({ order: [], leaves: [] });

  useEffect(() => {
    const order = state.sessions.map((s) => s.id);
    const leaves = leafSessionIds(state.layout.root);
    const before = prev.current;
    prev.current = { order, leaves };
    const f = focusedId;
    if (!f || f === abandoned) { return; }
    const removed = before.order.includes(f) && !order.includes(f);
    const hidden = before.leaves.includes(f) && !leaves.includes(f);
    if (!removed && !hidden) { return; }
    const alive = new Set(order);
    const leafAt = before.leaves.indexOf(f);
    const leafCandidates = [...before.leaves.slice(leafAt + 1), ...before.leaves.slice(0, Math.max(0, leafAt)).reverse()];
    const leaf = leafCandidates.find((id) => id !== f && alive.has(id) && leaves.includes(id));
    if (leaf) { placeOrFocus(leaf); return; }
    const at = before.order.indexOf(f);
    const candidates = at < 0 ? order : [...before.order.slice(at + 1), ...before.order.slice(0, at).reverse()];
    const next = candidates.find((id) => id !== f && alive.has(id));
    if (next) { placeOrFocus(next); } else { setAbandoned(f); }
  }, [state.sessions, state.layout, focusedId]);

  const focusSession = (id: SessionId) => { setAbandoned(null); placeOrFocus(id); };
  return { shownId: focusedId !== null && focusedId === abandoned ? null : focusedId, focusSession };
}
