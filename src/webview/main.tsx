import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@/components/ui/button';
import { Transcript } from './components/transcript';
import { StoreProvider, useStore } from './store';

function App() {
  const { state, post } = useStore();
  const first = state.sessions[0];

  useEffect(() => {
    post({ t: 'set-visible', sessionIds: first ? [first.id] : [] });
  }, [first?.id]);

  if (!state.ready) { return <div className="p-3 text-sm">Loading…</div>; }

  if (!first) {
    return (
      <Button
        className="m-3"
        onClick={() => post({ t: 'create-session', providerId: 'fake', cwd: '/tmp' })}
      >
        New session
      </Button>
    );
  }

  const pane = state.byId[first.id];
  return (
    <div className="flex h-screen flex-col">
      <div className="flex-1 overflow-hidden">
        {pane && <Transcript pane={pane} onLoadMore={(beforeItemId) =>
          post({ t: 'load-more', id: first.id, beforeItemId })} />}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="m-2"
        onClick={() => post({ t: 'send', id: first.id, text: 'hello' })}
      >
        Send test message
      </Button>
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
