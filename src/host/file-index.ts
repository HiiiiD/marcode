import type { FileRef } from '../protocol/messages';

const DEFAULT_LIMIT = 20;

function basename(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? path : path.slice(at + 1);
}

/**
 * `@file` row matching: substring on the path, case-insensitive — like
 * `filterMentions` on the webview side, but run host-side because the
 * webview never sees the workspace's file list at all.
 *
 * An empty query matches nothing, deliberately: `filterMentions` treats an
 * empty query as "show everything", which is right for a roster of a
 * handful of sessions and wrong for a workspace of thousands of files.
 *
 * A basename match ranks first, since typing `composer` almost always means
 * "the file called composer", not "any path containing those letters" — a
 * plain sort would put whichever path happened to list first.
 */
export function matchFiles(paths: string[], query: string, limit = DEFAULT_LIMIT): FileRef[] {
  if (query.length === 0) { return []; }
  const needle = query.toLowerCase();

  const rows = paths
    .map((path) => ({ path, name: basename(path) }))
    .filter((row) => row.path.toLowerCase().includes(needle))
    .sort((a, b) => {
      const aBase = a.name.toLowerCase().includes(needle);
      const bBase = b.name.toLowerCase().includes(needle);
      if (aBase !== bBase) { return aBase ? -1 : 1; }
      return a.path.length - b.path.length;
    });

  return rows.slice(0, limit);
}
