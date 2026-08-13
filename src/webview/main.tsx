import { createRoot } from 'react-dom/client';
import { StoreProvider, useStore } from './store';

function App() {
  const { state } = useStore();
  if (!state.ready) {
    return <div className="p-3 text-sm text-muted-foreground">Loading…</div>;
  }
  return (
    <div className="p-3 text-sm">
      {state.sessions.length} session(s), {state.catalog.length} provider(s)
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
