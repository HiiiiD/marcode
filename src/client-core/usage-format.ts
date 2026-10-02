import type { UsageWindow } from '../providers/types';
import { orderWindows } from '../shared/usage-windows';
import { clampPercent } from './context-format';

export const BAR_CELLS = 6;
const MIN_LABEL = 2;

// 24 columns cannot hold the providers' own labels ("Session (5h)"); unknown ids keep theirs.
const SHORT_LABEL: Record<string, string> = {
  'five-hour': '5h', 'seven-day': '7d', 'seven-day-opus': '7d opus', 'seven-day-sonnet': '7d sonnet',
};

export interface UsageWindowRow { id: string; label: string; percent: number; reset?: string }
export interface UsageProviderRow { id: string; name: string; windows: UsageWindowRow[] }

export function resetCountdown(resetsAt: number | undefined, now: number): string | undefined {
  if (resetsAt === undefined || resetsAt <= now) { return undefined; }
  const minutes = Math.floor((resetsAt - now) / 60_000);
  if (minutes < 1) { return '<1m'; }
  if (minutes < 60) { return `${minutes}m`; }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) { return `${hours}h${String(minutes % 60).padStart(2, '0')}m`; }
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

export function usageRows(
  by: Record<string, UsageWindow[] | undefined>, nameOf: (id: string) => string, now: number,
): UsageProviderRow[] {
  const rows: UsageProviderRow[] = [];
  for (const [id, all] of Object.entries(by)) {
    // The host prunes on read but the client keeps its copy until the next broadcast, which may be hours away.
    const live = (all ?? []).filter((w) => w.resetsAt === undefined || w.resetsAt > now);
    if (live.length === 0) { continue; }
    rows.push({
      id,
      name: nameOf(id),
      windows: orderWindows(live).map((w) => {
        const reset = resetCountdown(w.resetsAt, now);
        return { id: w.id, label: SHORT_LABEL[w.id] ?? w.label, percent: clampPercent(w.usedPercent), ...(reset ? { reset } : {}) };
      }),
    });
  }
  return rows;
}

export interface WindowLine { label: string; filled?: number; pct: string; reset?: string }

const cut = (text: string, width: number) => (text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`);

export function windowLine(w: UsageWindowRow, width: number, labelWidth: number): WindowLine {
  const pct = `${w.percent}%`;
  const filled = w.percent === 0 ? 0 : Math.max(1, Math.round((w.percent / 100) * BAR_CELLS));
  const size = (label: number, bar: boolean, reset: boolean) =>
    (label > 0 ? label + 1 : 0) + (bar ? BAR_CELLS + 1 : 0) + pct.length + (reset && w.reset ? 1 + w.reset.length : 0);
  const make = (label: number, bar: boolean, reset: boolean): WindowLine => ({
    label: label > 0 ? cut(w.label, label) : '',
    ...(bar ? { filled } : {}),
    pct,
    ...(reset && w.reset ? { reset: w.reset } : {}),
  });
  const attempts: [number, boolean, boolean][] = [[labelWidth, true, true], [labelWidth, true, false]];
  for (let l = labelWidth - 1; l >= MIN_LABEL; l--) { attempts.push([l, true, false]); }
  for (let l = labelWidth; l >= MIN_LABEL; l--) { attempts.push([l, false, false]); }
  const fit = attempts.find(([l, b, r]) => size(l, b, r) <= width);
  if (fit) { return make(...fit); }
  return { label: '', pct: pct.slice(0, Math.max(0, width)) };
}

export function windowLineText(line: WindowLine): string {
  const bar = line.filled === undefined ? undefined : '█'.repeat(line.filled) + '░'.repeat(BAR_CELLS - line.filled);
  return [line.label || undefined, bar, line.pct, line.reset].filter((p): p is string => p !== undefined && p !== '').join(' ');
}

export type StripLine = { kind: 'provider'; text: string } | { kind: 'window'; line: WindowLine };

export function stripLines(rows: UsageProviderRow[], width: number, maxLines: number): StripLine[] {
  const lines: StripLine[] = [];
  for (const row of rows) {
    lines.push({ kind: 'provider', text: cut(row.name, Math.min(row.name.length, width)).trimEnd() });
    const labelWidth = Math.min(Math.max(...row.windows.map((w) => w.label.length)), Math.max(MIN_LABEL, width - BAR_CELLS - 6));
    for (const w of row.windows) { lines.push({ kind: 'window', line: windowLine(w, width, labelWidth) }); }
  }
  return lines.slice(0, Math.max(0, maxLines));
}
