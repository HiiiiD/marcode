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

import type { FileChange, SessionId, TreeDiff } from '../../protocol/messages';

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
