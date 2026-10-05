import { clampDim } from '../../client-core/layout-apply';
import { BUILTIN_PRESETS, shapeMatches } from '../../client-core/layout-presets';
import { gridDims, type LayoutNode } from '../../client-core/layout-tree';
import type { LayoutPreset, SessionSummary } from '../../protocol/messages';

export interface PresetRow { kind: 'builtin' | 'saved'; preset: LayoutPreset; active: boolean }

export function presetRows(root: LayoutNode, saved: LayoutPreset[]): PresetRow[] {
  const row = (kind: PresetRow['kind']) => (preset: LayoutPreset): PresetRow => (
    { kind, preset, active: shapeMatches(root, preset.root) });
  return [...BUILTIN_PRESETS.map(row('builtin')), ...saved.map(row('saved'))];
}

/** A non-grid tree keeps the webview's default of 1x2 rather than inventing dims for it. */
export function initialDims(root: LayoutNode): { rows: number; cols: number } {
  const dims = gridDims(root);
  return dims ? { rows: clampDim(dims.rows), cols: clampDim(dims.cols) } : { rows: 1, cols: 2 };
}

export function gridPreview(rows: number, cols: number, filled: number): string[] {
  return Array.from({ length: rows }, (_, r) => (
    Array.from({ length: cols }, (_, c) => (r * cols + c < filled ? '[■]' : '[ ]')).join('')));
}

export function sessionTitles(ids: string[], sessions: SessionSummary[]): string[] {
  return ids.map((id) => {
    const s = sessions.find((x) => x.id === id);
    return s?.name || s?.title || id;
  });
}

export function overflowNotice(titles: string[]): string {
  return `${titles.length} session${titles.length === 1 ? '' : 's'} will be hidden: ${titles.join(', ')}`;
}
