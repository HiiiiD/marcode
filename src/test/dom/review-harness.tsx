import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import type * as ReviewAppModule from '../../review/review-app';
import type * as ReviewStoreModule from '../../review/store';

// Re-exported so a review spec imports one module. `harness.tsx` installs the
// acquireVsCodeApi stub at load time and owns the `sent` array; importing it
// here is what guarantees the stub exists before the review store's
// vscode-api import runs.
export { posted, resetHost, sendFromHost } from './harness';

const { ReviewApp } = require('../../review/review-app') as typeof ReviewAppModule;
const { StoreProvider } = require('../../review/store') as typeof ReviewStoreModule;

/**
 * NEVER hand the returned `container` — or any node queried out of it — to an
 * assertion as a value. See the long warning in `harness.tsx`: the node-valued
 * form allocated 3.5GB in 4 seconds. Compare booleans, strings or counts.
 */
export function renderReview(): RenderResult {
  return render(<StoreProvider><ReviewApp /></StoreProvider>);
}

/** Same assertion warning as `renderReview`. */
export function renderInReviewStore(ui: ReactNode): RenderResult {
  return render(<StoreProvider>{ui}</StoreProvider>);
}
