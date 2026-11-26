import { createContext, useContext, type ReactNode } from 'react';
import { tuiGaps, type TranscriptDensity } from '../../shared/transcript-density';

const GapsContext = createContext(tuiGaps('default'));

export function TranscriptGapsProvider({ density, children }: { density: TranscriptDensity; children: ReactNode }) {
  return <GapsContext value={tuiGaps(density)}>{children}</GapsContext>;
}

export const useTranscriptGaps = (): { message: number; tool: number } => useContext(GapsContext);
