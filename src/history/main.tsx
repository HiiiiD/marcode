import { createRoot } from 'react-dom/client';
import { HistoryApp } from './history-app';
import { StoreProvider } from './store';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StoreProvider>
      <HistoryApp />
    </StoreProvider>,
  );
}
