// Inspects real git working trees and performs the two-step move that brings a
// worktree's branch back into the main tree.
//
// Two rules shape everything here:
//
//  - **Every failure is a returned reason, never a throw.** A session that
//    cannot be relocated must show the user why, and an exception crossing the
//    host would be swallowed as an unhandled rejection instead. `treeStatus`
//    answers `isRepo: false` for anything it cannot read; `bringBackPlan`
//    answers `{ ok: false, reason }`; `bringBack` answers `{ ok, reason? }`.
//  - **Never `shell: true`.** Paths contain spaces, and this is the boundary
//    where a directory name would otherwise become shell syntax. `execFile`
//    with an argv array and an explicit `cwd` is the only way git is invoked.
//
// No `vscode` import: this is unit-tested outside the extension host.

import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { BringBackPlan } from '../protocol/messages';

const execFileAsync = promisify(execFile);

export interface TreeStatus {
  isRepo: boolean;
  root: string;
  branch?: string;
  clean: boolean;
  isWorktree: boolean;
  mainRoot?: string;
}

// The plan crosses the wire, so it is declared in the protocol and re-exported
// here for the callers that only know this module. Type-only in both
// directions: nothing runtime moves between the two.
export type { BringBackPlan };

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, out: stdout.trim(), err: stderr.trim() };
  } catch (error) {
    const shaped = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      out: (shaped.stdout ?? '').trim(),
      err: (shaped.stderr ?? shaped.message ?? 'git failed').trim(),
    };
  }
}

const NOT_A_REPO: TreeStatus = { isRepo: false, root: '', clean: false, isWorktree: false };

/**
 * Git answers with forward slashes even on Windows; `resolve` puts a path back
 * into the platform's own spelling so it can be compared with — and handed to
 * — paths this process built with `node:path`.
 */
function normalize(gitPath: string): string {
  return resolve(gitPath.trim());
}

/**
 * Windows path comparison is case-insensitive; POSIX is not.
 *
 * Exported because the stale-tree sweep compares the paths this module hands
 * back (`TreeStatus.root`, always `resolve`d) against the ones sessions carry,
 * and a second spelling of this rule elsewhere is a second thing to get wrong
 * on one platform only. Both arguments are expected to be absolute already.
 */
export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

export async function treeStatus(dir: string): Promise<TreeStatus> {
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') { return NOT_A_REPO; }

  // None of these five reads depends on another's answer — each is its own
  // git spawn against the same `dir` — so firing them together turns five
  // sequential process spawns into one round of concurrent ones. Only the
  // `inside` gate above stays sequential first: it is what tells a non-repo
  // apart, and there is nothing to read yet if `dir` is not one.
  const [top, branch, porcelain, commonDir, gitDir] = await Promise.all([
    git(dir, ['rev-parse', '--show-toplevel']),
    git(dir, ['branch', '--show-current']),
    git(dir, ['status', '--porcelain']),
    git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    git(dir, ['rev-parse', '--path-format=absolute', '--git-dir']),
  ]);
  if (!top.ok || top.out === '') { return NOT_A_REPO; }
  const root = normalize(top.out);

  // A linked worktree has its own git dir under `<main>/.git/worktrees/<name>`
  // while its *common* dir stays `<main>/.git`. In the main tree the two agree.
  const isWorktree = commonDir.ok && gitDir.ok
    && commonDir.out !== '' && gitDir.out !== ''
    && !samePath(normalize(commonDir.out), normalize(gitDir.out));

  const mainRoot = isWorktree ? dirname(normalize(commonDir.out)) : root;

  return {
    isRepo: true,
    root,
    branch: branch.ok && branch.out !== '' ? branch.out : undefined,
    clean: porcelain.ok && porcelain.out === '',
    isWorktree,
    mainRoot,
  };
}

export async function bringBackPlan(worktreeDir: string): Promise<BringBackPlan> {
  const tree = await treeStatus(worktreeDir);
  if (!tree.isRepo) {
    return {
      ok: false, isWorktree: false,
      reason: `${worktreeDir} is not a git repository.`,
    };
  }
  if (!tree.isWorktree || tree.mainRoot === undefined) {
    return {
      ok: false, isWorktree: false,
      reason: 'This directory is the main working tree, not a linked worktree, so there is nothing to bring back.',
    };
  }
  // Everything below this line IS a linked worktree, so every refusal is a
  // "not now", not a "not here" — see `BringBackPlan.isWorktree`.
  if (tree.branch === undefined) {
    return {
      ok: false, isWorktree: true,
      reason: 'The worktree has a detached HEAD, so there is no branch to bring back. Check a branch out there first.',
    };
  }
  if (!tree.clean) {
    return {
      ok: false, isWorktree: true,
      reason: 'The worktree has uncommitted changes. Commit or discard them before bringing the branch back.',
    };
  }

  const main = await treeStatus(tree.mainRoot);
  if (!main.isRepo) {
    return {
      ok: false, isWorktree: true,
      reason: `The main working tree at ${tree.mainRoot} could not be read.`,
    };
  }
  if (!main.clean) {
    return {
      ok: false, isWorktree: true,
      reason: `The main working tree at ${main.root} has uncommitted changes. Commit or discard them first.`,
    };
  }

  return { ok: true, branch: tree.branch, worktree: tree.root, mainRoot: main.root };
}

/**
 * Removal first, then checkout. The order is forced by git: the same branch
 * cannot be checked out in two trees at once, so the branch is only free to
 * enter the main root after its worktree is gone.
 *
 * `removed` reports how far it got, because the two failures are different
 * situations on disk. A refused removal changed nothing. A failed checkout did
 * — the directory is gone — and a caller holding a session pointed at it needs
 * to know that leaving it there is no longer an option.
 */
export async function bringBack(
  plan: BringBackPlan & { ok: true },
): Promise<{ ok: boolean; reason?: string; removed: boolean }> {
  const removed = await git(plan.mainRoot, ['worktree', 'remove', plan.worktree]);
  if (!removed.ok) {
    return {
      ok: false, removed: false,
      reason: `Could not remove the worktree: ${removed.err || 'git failed'}`,
    };
  }

  const checkedOut = await git(plan.mainRoot, ['checkout', plan.branch]);
  if (!checkedOut.ok) {
    return {
      ok: false, removed: true,
      reason: `The worktree at ${plan.worktree} was removed, but ${plan.branch} could not be`
        + ` checked out in ${plan.mainRoot}: ${checkedOut.err || 'git failed'}.`
        + ` The branch still exists — check it out there by hand.`,
    };
  }

  return { ok: true, removed: true };
}
