import { render, type RenderResult } from '@testing-library/react';
import type * as HistoryAppModule from '../../history/history-app';
import type * as HistoryStoreModule from '../../history/store';

// `harness.tsx` installs the acquireVsCodeApi stub at load time; importing it
// first is what guarantees the stub exists before the store's vscode-api import runs.
export { posted, resetHost, sendFromHost } from './harness';

const { HistoryApp } = require('../../history/history-app') as typeof HistoryAppModule;
const { StoreProvider } = require('../../history/store') as typeof HistoryStoreModule;

/**
 * NEVER hand the returned `container` — or any node queried out of it — to an
 * assertion as a value. See the warning in `harness.tsx`.
 */
export function renderHistory(): RenderResult {
  return render(<StoreProvider><HistoryApp /></StoreProvider>);
}
