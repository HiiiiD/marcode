// The flat wire payload, grouped the way it is read.
//
// The host sends a tree carrying files, and each file carrying the sessions
// that claimed it. That shape is deliberate: pre-grouping on the wire would
// duplicate every file two sessions claim, and make the shared-file case
// unrepresentable without a second, contradicting copy of its diff. The
// duplication belongs here, in the view, where it is a rendering choice
// rather than a fact about the data.
//
// No React and no `@/` aliases: this is required directly from the mocha
// harness, the same rule `pane-layout.ts` follows.

import type { FileChange, SessionId, TreeDiff } from '../protocol/messages';

export interface SessionGroup {
  /** `null` is the unattributed group — see `groupTree`. */
  sessionId: SessionId | null;
  files: FileChange[];
  insertions: number;
  deletions: number;
}

function churn(files: FileChange[]): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const file of files) {
    // A binary file reports no counts. Adding 0 would be a lie of the same
    // size, but a smaller one than treating `undefined` as arithmetic.
    insertions += file.insertions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return { insertions, deletions };
}

/**
 * One group per session that claimed something, in roster order, then the
 * unattributed group.
 *
 * A session with no claims gets no group at all: an empty group would read as
 * "this session did nothing", when what happened is that everything it did is
 * already gone from the working tree, or it never touched this tree.
 *
 * Unattributed sorts last because it is the group that needs explaining, and
 * a header explaining it should not be the first thing between the user and
 * the changes they came to read.
 */
export function groupTree(tree: TreeDiff): SessionGroup[] {
  const groups: SessionGroup[] = [];

  for (const sessionId of tree.sessions) {
    const files = tree.files.filter((f) => f.claimedBy.includes(sessionId));
    if (files.length === 0) { continue; }
    groups.push({ sessionId, files, ...churn(files) });
  }

  const unclaimed = tree.files.filter((f) => f.claimedBy.length === 0);
  if (unclaimed.length > 0) {
    groups.push({ sessionId: null, files: unclaimed, ...churn(unclaimed) });
  }

  return groups;
}

/**
 * The header line: how many files changed, and — when it would otherwise
 * contradict the rows below it — why there are more rows than files.
 *
 * `groupTree` lists a file under every session that claimed it, deliberately:
 * two agents writing one file is the case this surface exists to catch, and
 * seeing it under only one of them would hide exactly that. But it means the
 * row count can exceed the file count, and a bare "5 files" over six rows is
 * a header the user has to disbelieve. The count stays per file — that is the
 * question "what changed" asks — and the second clause accounts for the
 * difference rather than letting the number absorb it.
 *
 * Paths need no de-duplication within a tree (git reports each once) and must
 * not be de-duplicated across trees: the same relative path in two working
 * trees is two different files.
 */
export function summarize(trees: TreeDiff[]): string {
  let files = 0;
  let shared = 0;
  for (const tree of trees) {
    files += tree.files.length;
    shared += tree.files.filter((f) => f.claimedBy.length > 1).length;
  }

  let label = `${files} changed ${files === 1 ? 'file' : 'files'}`;
  if (trees.length > 1) { label += ` in ${trees.length} working trees`; }
  if (shared > 0) {
    label += `, ${shared} listed under more than one session`;
  }
  return label;
}

/**
 * A tree with only the files the user asked to see.
 *
 * Filtering happens on the tree, before grouping, so an emptied session group
 * disappears rather than rendering as a header over nothing — an empty group
 * reads as "this session did nothing", which under a filter is false.
 *
 * `omitted` is deliberately carried through untouched: it counts files the
 * *host* never sent, and a filter cannot know whether they would have matched.
 */
export function filterTree(tree: TreeDiff, query: string, contestedOnly: boolean): TreeDiff {
  const needle = query.trim().toLowerCase();
  if (needle === '' && !contestedOnly) { return tree; }

  const files = tree.files.filter((file) => {
    if (contestedOnly && file.claimedBy.length < 2) { return false; }
    if (needle === '') { return true; }
    return file.path.toLowerCase().includes(needle);
  });

  return { ...tree, files };
}

/** Files across every tree. Paths are never de-duplicated across trees: the
 * same relative path in two working trees is two different files. */
export function countFiles(trees: TreeDiff[]): number {
  return trees.reduce((total, tree) => total + tree.files.length, 0);
}

/**
 * The deepest directory every path shares, with its trailing slash.
 *
 * Directory-boundary only: `src/webview/` and `src/west/` share the string
 * `src/we`, and eliding that would leave rows spelling paths that do not
 * exist. Paths are git's repo-relative POSIX spelling, so `/` is the only
 * separator to consider.
 */
export function commonPrefix(paths: string[]): string {
  if (paths.length === 0) { return ''; }
  let prefix = paths[0].slice(0, paths[0].lastIndexOf('/') + 1);
  for (const path of paths.slice(1)) {
    while (prefix !== '' && !path.startsWith(prefix)) {
      // Drop one segment: cut the trailing slash, then back to the previous one.
      prefix = prefix.slice(0, prefix.lastIndexOf('/', prefix.length - 2) + 1);
    }
    if (prefix === '') { return ''; }
  }
  return prefix;
}

export function stripPrefix(path: string, prefix: string): string {
  return prefix !== '' && path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * One directory in a session group's file list, nested.
 *
 * `dirPath` is this folder's full path *from the group's already-elided
 * prefix*, trailing slash included (`'src/webview/'`), empty for the
 * synthetic root — it is what the fleet-diff surface namespaces its
 * folder-collapse keys with, so it has to be unique within one group and
 * stable across a 750ms rebuild, which a plain array index is not.
 */
export interface FolderNode {
  dirPath: string;
  /** Last path segment, no slash. Empty for the synthetic root. */
  name: string;
  folders: FolderNode[];
  files: FileChange[];
}

/**
 * Nests a session group's files by directory, folders before files and both
 * alphabetical at every level — the order a file explorer reads in, and the
 * order `flattenFolder` (fleet-diff.tsx) walks to build the roving row list.
 *
 * `prefix` is the same string `commonPrefix` already computes for the group:
 * stripped before nesting, so the directory the group header already names
 * once above the rows grows no folder node of its own.
 */
export function buildFolderTree(files: FileChange[], prefix: string): FolderNode {
  const root: FolderNode = { dirPath: '', name: '', folders: [], files: [] };
  for (const file of files) {
    const segments = stripPrefix(file.path, prefix).split('/');
    // The last segment is the filename, not a directory — never turned into
    // a folder node even when it is the only segment (a root-level file).
    segments.pop();
    let cursor = root;
    let dirPath = '';
    for (const segment of segments) {
      dirPath += `${segment}/`;
      let next = cursor.folders.find((folder) => folder.name === segment);
      if (next === undefined) {
        next = {
          dirPath, name: segment, folders: [], files: [],
        };
        cursor.folders.push(next);
      }
      cursor = next;
    }
    cursor.files.push(file);
  }
  sortFolderTree(root);
  return root;
}

function sortFolderTree(node: FolderNode): void {
  node.folders.sort((a, b) => a.name.localeCompare(b.name));
  node.files.sort((a, b) => a.path.localeCompare(b.path));
  node.folders.forEach(sortFolderTree);
}
