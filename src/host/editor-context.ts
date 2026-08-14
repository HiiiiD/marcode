import * as path from 'node:path';
import type { EditorContext } from '../providers/types';

/** Total selected characters carried in one message. A guess; one constant to tune. */
export const SELECTION_BUDGET = 8000;

type Range = { startLine: number; endLine: number; text: string };

/**
 * A plain-data view of an editor. `src/host/vscode-editor-source.ts` is the
 * only place that builds one from the real VS Code API, which keeps
 * everything below unit-testable outside the extension host.
 *
 * `ranges` are 1-based inclusive and may arrive unsorted, empty, or
 * overlapping — normalizing them is this module's job.
 */
export interface EditorSnapshot {
  fsPath: string;
  scheme: string;
  languageId: string;
  ranges: Range[];
}

export function toEditorContext(
  snap: EditorSnapshot, workspaceRoots: string[],
): EditorContext | null {
  // Only real files. Output channels, webviews, untitled buffers and virtual
  // documents have no path worth sending.
  if (snap.scheme !== 'file') { return null; }

  const base: EditorContext = {
    path: displayPath(snap.fsPath, workspaceRoots),
    languageId: snap.languageId,
  };

  const merged = mergeRanges(snap.ranges.filter((r) => r.text.length > 0));
  if (merged.length === 0) { return base; }

  const { ranges, truncated } = applyBudget(merged);
  if (ranges.length === 0) { return base; }
  return { ...base, selection: { ranges, truncated } };
}

/**
 * Workspace-relative when the file sits under an open folder, absolute
 * otherwise. The longest matching root wins so a nested folder in a
 * multi-root workspace produces the shorter, more useful path.
 */
function displayPath(fsPath: string, workspaceRoots: string[]): string {
  const candidates = workspaceRoots
    .filter((root) => isInside(root, fsPath))
    .sort((a, b) => b.length - a.length);
  const root = candidates[0];
  const chosen = root ? path.relative(root, fsPath) : fsPath;
  return chosen.split(path.sep).join('/');
}

function isInside(root: string, fsPath: string): boolean {
  const rel = path.relative(root, fsPath);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * VS Code never hands out overlapping selections (it collapses multi-cursor
 * selections that touch), so merging is really about *adjacent* ranges —
 * two selections covering lines 10-12 and 13-14 read better as one block.
 * Overlap is handled anyway rather than trusting that invariant.
 */
function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const out: Range[] = [];
  for (const range of sorted) {
    const prev = out[out.length - 1];
    if (prev && range.startLine <= prev.endLine + 1) {
      out[out.length - 1] = {
        startLine: prev.startLine,
        endLine: Math.max(prev.endLine, range.endLine),
        text: `${prev.text}\n${range.text}`,
      };
      continue;
    }
    out.push({ ...range });
  }
  return out;
}

/**
 * Fill ranges in document order until the budget runs out. A range that
 * doesn't fit is cut at the boundary (and its end line recomputed, so the
 * label never claims lines that aren't in the text); everything after it is
 * dropped. Either way `truncated` tells the model it is reading a partial
 * view.
 */
function applyBudget(ranges: Range[]): { ranges: Range[]; truncated: boolean } {
  const out: Range[] = [];
  let used = 0;
  for (const range of ranges) {
    const remaining = SELECTION_BUDGET - used;
    if (remaining <= 0) { return { ranges: out, truncated: true }; }
    if (range.text.length <= remaining) {
      out.push(range);
      used += range.text.length;
      continue;
    }
    const text = range.text.slice(0, remaining);
    out.push({
      startLine: range.startLine,
      endLine: range.startLine + countNewlines(text),
      text,
    });
    return { ranges: out, truncated: true };
  }
  return { ranges: out, truncated: false };
}

function countNewlines(text: string): number {
  let n = 0;
  for (const ch of text) { if (ch === '\n') { n++; } }
  return n;
}
