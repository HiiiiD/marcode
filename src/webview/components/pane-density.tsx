import { createContext, useContext } from 'react';

export type PaneDensity = 'comfortable' | 'compact' | 'strip';

export const PaneDensityContext = createContext<PaneDensity>('comfortable');

export function usePaneDensity(): PaneDensity {
  return useContext(PaneDensityContext);
}

// Below this pane height the header slims down; 5 stacked panes in a laptop sidebar land under it.
export const COMPACT_BELOW_PX = 380;

// A pane this short (everything but one maximized pane) cannot show a transcript or composer; it is just its header, and a click brings it back.
export const STRIP_BELOW_PX = 150;
export const STRIP_BELOW_WIDTH_PX = 170;

// A narrow pane, such as one of five side by side, cannot hold the full composer footer on one row either.
export const COMPACT_BELOW_WIDTH_PX = 400;
