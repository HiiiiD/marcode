import type { FileRef } from '../protocol/messages';

const DEFAULT_LIMIT = 20;

export interface IndexedPath { path: string; lower: string; nameStart: number }

export function indexPaths(paths: string[]): IndexedPath[] {
  return paths.map((path) => ({ path, lower: path.toLowerCase(), nameStart: path.lastIndexOf('/') + 1 }));
}

const isBoundary = (lower: string, i: number) => i === 0 || '/-_. '.includes(lower[i - 1]);

/**
 * Score of `needle` against one path, or -1 for no match. A contiguous hit wins over a scattered one, a hit in the
 * basename over one in a directory, and a hit at a word boundary over one mid-word; `@cmpsr` still finds
 * `composer.tsx` as a last resort. Shorter paths break ties, so `foo.ts` beats `foo-long-name.ts`.
 */
export function scorePath(entry: IndexedPath, needle: string): number {
  const { lower, nameStart } = entry;
  const at = lower.lastIndexOf(needle);
  if (at >= 0) {
    const inName = at >= nameStart;
    const first = lower.indexOf(needle, inName ? nameStart : 0);
    const where = inName ? Math.max(first, nameStart) : first;
    let score = inName ? 2000 : 1000;
    if (isBoundary(lower, where)) { score += 300; }
    if (where === nameStart) { score += 200; }
    return score - lower.length;
  }
  let score = 0;
  let from = 0;
  let prev = -2;
  for (let n = 0; n < needle.length; n++) {
    const hit = lower.indexOf(needle[n], from);
    if (hit < 0) { return -1; }
    score += 10;
    if (hit === prev + 1) { score += 15; }
    if (isBoundary(lower, hit)) { score += 12; }
    if (hit >= nameStart) { score += 6; }
    prev = hit;
    from = hit + 1;
  }
  return score - lower.length / 10;
}

/**
 * `@file` row matching, run host-side because the webview never sees the workspace's file list.
 *
 * An empty query matches nothing, deliberately: `filterMentions` treats an empty query as "show everything",
 * which is right for a roster of a handful of sessions and wrong for a workspace of thousands of files.
 *
 * Only the best `limit` rows are kept while scanning, so a one-letter query over a huge tree does not sort the tree.
 */
export function searchIndex(index: IndexedPath[], query: string, limit = DEFAULT_LIMIT): FileRef[] {
  if (query.length === 0) { return []; }
  const needle = query.toLowerCase();
  const best: { entry: IndexedPath; score: number }[] = [];
  for (const entry of index) {
    const score = scorePath(entry, needle);
    if (score < 0 || (best.length === limit && score <= best[limit - 1].score)) { continue; }
    let i = best.length;
    while (i > 0 && best[i - 1].score < score) { i--; }
    best.splice(i, 0, { entry, score });
    if (best.length > limit) { best.pop(); }
  }
  return best.map(({ entry }) => ({ path: entry.path, name: entry.path.slice(entry.nameStart) }));
}

export function matchFiles(paths: string[], query: string, limit = DEFAULT_LIMIT): FileRef[] {
  return searchIndex(indexPaths(paths), query, limit);
}
