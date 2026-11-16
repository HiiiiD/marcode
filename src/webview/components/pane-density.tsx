import { createContext, useContext } from 'react';

export type PaneDensity = 'comfortable' | 'compact';

export const PaneDensityContext = createContext<PaneDensity>('comfortable');

export function usePaneDensity(): PaneDensity {
  return useContext(PaneDensityContext);
}

// Below this pane height the header and composer collapse to one slim row each; 5 stacked panes in a laptop sidebar land under it.
export const COMPACT_BELOW_PX = 380;
