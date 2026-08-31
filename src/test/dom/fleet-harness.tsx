// src/test/dom/fleet-harness.tsx
import type { RenderResult } from '@testing-library/react';
import type * as FleetAppModule from '../../fleet/fleet-app';
import { renderWithStore } from './harness';

// Re-exported so a fleet spec imports one module, same precedent as before.
export { posted, resetHost, sendFromHost } from './harness';

const { FleetApp } = require('../../fleet/fleet-app') as typeof FleetAppModule;

/** Same assertion warning as `renderApp`/`renderWithStore` — never assert on a node. */
export function renderFleet(): RenderResult {
  return renderWithStore(<FleetApp />);
}
