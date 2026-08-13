import { createRoot } from 'react-dom/client';
import { App } from './app';
import { StoreProvider } from './store';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StoreProvider>
      <App />
    </StoreProvider>,
  );
}
