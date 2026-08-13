import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { PaneGroup } from './components/pane-group';
import { SessionPicker } from './components/session-picker';
import { reconcilePaneLayout } from './components/pane-layout';
import { StoreProvider, useStore } from './store';

function App() {
  const { state, post } = useStore();

  const byIdKeys = Object.keys(state.byId);
  const sessionsKey = state.sessions.map((s) => `${s.id}:${s.archived}`).join(',');
  const paneIdsKey = state.layout.panes.map((p) => p.sessionId).join(',');

  // New sessions open into a pane; closed/deleted ones fall out of one. The
  // host doesn't drive this (it has no concept of "which panes the client
  // currently shows" beyond the last `set-layout` it was told about), so the
  // client reconciles its own layout against the roster on every roster or
  // snapshot-arrival change. reconcilePaneLayout() (pane-layout.ts) is a
  // no-op (`null`) once the layout already matches, so this doesn't loop.
  useEffect(() => {
    const eligible = new Set(state.sessions.filter((s) => !s.archived).map((s) => s.id));
    const next = reconcilePaneLayout(state.layout, eligible, byIdKeys);
    if (!next) { return; }
    post({ t: 'set-layout', layout: next });
    post({ t: 'set-visible', sessionIds: next.panes.map((p) => p.sessionId) });
  }, [byIdKeys.join(','), sessionsKey, paneIdsKey]);

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

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StoreProvider>
      <App />
    </StoreProvider>,
  );
}
