import { createRoot } from 'react-dom/client';
import { FleetApp } from './fleet-app';
import { StoreProvider } from '../webview/store';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StoreProvider>
      <FleetApp />
    </StoreProvider>,
  );
}
