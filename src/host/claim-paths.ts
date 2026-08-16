// Provider paths in, git paths out.
//
// `FileEdit.path` is "absolute where the provider gave one, POSIX
// separators" — otherwise relative to the session's cwd. Git reports
// repo-relative POSIX. Everything between those two spellings lives here, in
// one place, because a second spelling of this rule elsewhere is a second
// thing to get wrong on one platform only.
//
// No `vscode` import.

import { relative, resolve } from 'node:path';
import { samePath } from './git-worktree';
import type { ToolCall } from '../providers/canonical/tool-call';

/**
 * Every path a tool call wrote, absolute, in the platform's own spelling.
 *
 * Absolute rather than repo-relative on purpose: the tree root is an async
 * git question, and this is called from a synchronous `tool-end` handler.
 * The conversion to repo-relative happens at diff-assembly time, where the
 * root is already known.
 */
export function claimedPaths(tool: ToolCall, cwd: string): string[] {
  if (tool.kind !== 'file-edit') { return []; }
  return tool.files.map((file) => resolve(cwd, file.path));
}

/**
 * `absolute` expressed relative to `root`, POSIX-separated, or undefined when
 * it is not inside `root` at all.
 *
 * A path outside the tree is dropped rather than clamped. An agent writing
 * outside its own tree is a real event, but it is not this tree's diff, and a
 * clamped path would attach it to a file that has nothing to do with it.
 *
 * Case sensitivity is `samePath`'s rule — case-insensitive on win32 only —
 * reached by comparing the round trip rather than respelling it here.
 */
export function toRepoRelative(absolute: string, root: string): string | undefined {
  const full = resolve(absolute);
  const base = resolve(root);
  if (samePath(full, base)) { return undefined; }

  const rel = relative(base, full);
  // `relative` answers with `..` segments for anything outside, and an
  // absolute path when the two sit on different win32 drives. The round trip
  // is compared through `samePath`, never with `!==`: on win32 a strict
  // compare would reject `E:\Repo\a.ts` against `e:\repo\a.ts` and silently
  // drop the claim for a file that is plainly inside the tree.
  if (rel === '' || rel.startsWith('..')) { return undefined; }
  if (!samePath(resolve(base, rel), full)) { return undefined; }

  return rel.split('\\').join('/');
}
