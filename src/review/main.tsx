import { createRoot } from 'react-dom/client';
import { ReviewApp } from './review-app';
import { StoreProvider } from './store';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StoreProvider>
      <ReviewApp />
    </StoreProvider>,
  );
}
