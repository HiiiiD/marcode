import { createContext, useContext } from 'react';

export type PaneDensity = 'comfortable' | 'compact' | 'strip' | 'rail';

export const PaneDensityContext = createContext<PaneDensity>('comfortable');

export function usePaneDensity(): PaneDensity {
  return useContext(PaneDensityContext);
}

// A pane this short (everything but one maximized pane) cannot show a transcript or composer; it is just its header, and a click brings it back.
export const STRIP_BELOW_PX = 150;
export const STRIP_BELOW_WIDTH_PX = 140;

// Width alone decides what the header shows, so a stacked pane and a side-by-side pane of the same width read the same.
export const COMPACT_BELOW_WIDTH_PX = 400;
