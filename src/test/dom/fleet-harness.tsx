import { render, type RenderResult } from '@testing-library/react';
import type * as FleetAppModule from '../../fleet/fleet-app';
import type * as FleetStoreModule from '../../fleet/store';

// Re-exported so a fleet spec imports one module. `harness.tsx` installs the
// acquireVsCodeApi stub at load time and owns the `sent` array; importing it
// here is what guarantees the stub exists before the fleet store's
// vscode-api import runs.
export { posted, resetHost, sendFromHost } from './harness';

const { FleetApp } = require('../../fleet/fleet-app') as typeof FleetAppModule;
const { StoreProvider } = require('../../fleet/store') as typeof FleetStoreModule;

/**
 * NEVER hand the returned `container` — or any node queried out of it — to an
 * assertion as a value. See the long warning in `harness.tsx`: the node-valued
 * form allocated 3.5GB in 4 seconds. Compare booleans, strings or counts.
 */
export function renderFleet(): RenderResult {
  return render(<StoreProvider><FleetApp /></StoreProvider>);
}
