import { useEffect, useRef } from 'react';
import { PaneGroup } from './components/pane-group';
import { SessionPicker } from './components/session-picker';
import { reconcilePaneLayout, rosterSessionIds } from './components/pane-layout';
import { useStore } from './store';

export function App() {
  const { state, post } = useStore();

  const byIdKeys = Object.keys(state.byId);
  const rosterKey = state.sessions.map((s) => s.id).join(',');
  const paneIdsKey = state.layout.panes.map((p) => p.sessionId).join(',');
  // Session ids this client has already offered a pane at least once (see
  // reconcilePaneLayout's doc comment): once a session is "known", removing
  // its pane is the user's choice (roster checkbox / close) and reconcile
  // must never put it back. Only a session whose `byId` snapshot arrives for
  // the very first time — a freshly created session — gets auto-appended.
  const knownSessionIdsRef = useRef<Set<string>>(new Set());

  // A pane's session can be deleted outright (removed from the roster
  // entirely, unlike close-session which only archives it) or a brand new
  // session can arrive that has no pane yet. The host doesn't drive this —
  // it has no concept of "which panes the client currently shows" beyond
  // the last `set-layout` it was told — so the client reconciles its own
  // layout against the roster on every roster/snapshot-arrival change.
  // reconcilePaneLayout() (pane-layout.ts) returns `layout: null` once the
  // layout already matches, so this doesn't loop.
  useEffect(() => {
    const roster = rosterSessionIds(state.sessions);
    const result = reconcilePaneLayout(
      state.layout, roster, byIdKeys, knownSessionIdsRef.current,
    );
    knownSessionIdsRef.current = result.knownSessionIds;
    if (result.layout) {
      post({ t: 'set-layout', layout: result.layout });
    }
  }, [byIdKeys.join(','), rosterKey, paneIdsKey]);

  // `set-visible` must be posted whenever the *set of panes shown* changes,
  // independent of whether reconciliation above found anything to change —
  // after a clean reload the persisted layout already matches the roster
  // (reconcile is a no-op), but `SessionManager.visible` starts empty and
  // `ready`'s `hydrate` never calls `setVisible`, so without this every
  // restored pane would sit dead (no `session-patch` ever reaches it) until
  // the user happened to create or close a session. Keyed on `paneIdsKey`
  // alone so it doesn't re-fire on every render, only when the shown pane
  // set actually changes.
  useEffect(() => {
    post({ t: 'set-visible', sessionIds: state.layout.panes.map((p) => p.sessionId) });
  }, [paneIdsKey]);

  if (!state.ready) {
    return <div className="p-3 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex h-screen flex-col">
      <SessionPicker />
      <div className="min-h-0 flex-1"><PaneGroup /></div>
    </div>
  );
}
