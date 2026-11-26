export const TRANSCRIPT_DENSITIES = ['compact', 'default', 'comfortable'] as const;
export type TranscriptDensity = typeof TRANSCRIPT_DENSITIES[number];

// Relative to VS Code's font size: at the default 13px, compact lands on 12px and comfortable on 14px.
const PANEL_SCALE: Record<TranscriptDensity, number> = { compact: 0.92, default: 1, comfortable: 1.08 };

/** The panel's override, empty for the default so `index.css`'s own `--transcript-scale` stands. */
export function densityToCss(density: TranscriptDensity): string {
  return density === 'default' ? '' : `:root{--transcript-scale:${PANEL_SCALE[density]}}`;
}

/**
 * Blank lines the terminal client leaves under a message, and between two consecutive tool rows: a terminal cannot
 * change its font size, only its spacing. Flat tool rows stack as one work log, like the panel's.
 */
export function tuiGaps(density: TranscriptDensity): { message: number; tool: number } {
  if (density === 'compact') { return { message: 0, tool: 0 }; }
  if (density === 'comfortable') { return { message: 2, tool: 1 }; }
  return { message: 1, tool: 0 };
}

export function parseTranscriptSettings(raw: unknown): { density: TranscriptDensity; warnings: string[] } {
  if (raw === undefined) { return { density: 'default', warnings: [] }; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { density: 'default', warnings: ['config.json: transcript is not an object; using the default.'] };
  }
  const density = (raw as { density?: unknown }).density;
  if (density === undefined) { return { density: 'default', warnings: [] }; }
  if (TRANSCRIPT_DENSITIES.includes(density as TranscriptDensity)) { return { density: density as TranscriptDensity, warnings: [] }; }
  return { density: 'default', warnings: [`config.json: transcript.density must be one of ${TRANSCRIPT_DENSITIES.join(', ')}; using the default.`] };
}
