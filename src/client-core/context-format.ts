import type { ContextBreakdown } from '../providers/types';
import { formatTokens } from './format-tokens';

/** Above this share of the window, colour alone stops carrying the signal. */
export const DANGER_PERCENT = 80;

export type SliceKey = 'system' | 'memory' | 'conversation' | 'free';

export interface ContextModel {
  slices: { key: SliceKey; label: string; percent: number }[];
  memoryFiles: { path: string; percent: string }[];
  window?: string;
}

/** A provider reports a percentage; nothing guarantees it is one. */
export function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export function contextModel(b: ContextBreakdown): ContextModel {
  const window = b.usedTokens !== undefined && b.windowTokens !== undefined
    ? `${formatTokens(b.usedTokens)} of ${formatTokens(b.windowTokens)} tokens`
    : undefined;
  return {
    slices: [
      { key: 'system', label: 'System prompt', percent: clampPercent(b.systemPercent) },
      { key: 'memory', label: 'Memory', percent: clampPercent(b.memoryPercent) },
      { key: 'conversation', label: 'Conversation', percent: clampPercent(b.conversationPercent) },
      { key: 'free', label: 'Free', percent: clampPercent(b.freePercent) },
    ],
    // A listed file rounding to 0 is present but tiny, never "nothing".
    memoryFiles: b.memoryFiles.map((f) => {
      const p = clampPercent(f.percent);
      return { path: f.path, percent: p === 0 ? '<1%' : `${p}%` };
    }),
    ...(window ? { window } : {}),
  };
}

/** Largest-remainder split of `width` cells; a nonzero slice keeps at least one cell. */
export function stackedBar(slices: { key: SliceKey; percent: number }[], width: number): { key: SliceKey; cells: number }[] {
  const total = slices.reduce((n, s) => n + s.percent, 0);
  if (total <= 0 || width <= 0) { return slices.map((s) => ({ key: s.key, cells: 0 })); }
  const raw = slices.map((s) => (s.percent / total) * width);
  const cells = raw.map(Math.floor);
  let left = width - cells.reduce((n, c) => n + c, 0);
  const byFraction = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f);
  for (const { i } of byFraction) {
    if (left <= 0) { break; }
    cells[i] += 1;
    left -= 1;
  }
  slices.forEach((s, i) => {
    if (s.percent > 0 && cells[i] === 0) {
      const donor = cells.indexOf(Math.max(...cells));
      cells[donor] -= 1;
      cells[i] = 1;
    }
  });
  return slices.map((s, i) => ({ key: s.key, cells: cells[i] }));
}

/** The identifying end of a path is its tail, so the front gives way. */
export function fitPath(path: string, width: number): string {
  if (path.length <= width) { return path; }
  return width <= 1 ? '…' : `…${path.slice(-width)}`;
}

export function headerLabel(percent: number | undefined): { text: string; danger: boolean } {
  if (percent === undefined) { return { text: 'unavailable', danger: false }; }
  return { text: `${percent}% used`, danger: percent >= DANGER_PERCENT };
}
