import * as path from 'node:path';
import { createWorktree, git, samePath } from '../git-worktree';
import type { ProjectResolver } from '../project/project-resolver';

import type { CheckoutChoice } from '../../protocol/messages';

export type { CheckoutChoice };

function parseWorktrees(porcelain: string): CheckoutChoice[] {
  const out: CheckoutChoice[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const root = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (!root) { continue; }
    const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch refs/heads/'.length);
    out.push({ root: path.resolve(root), ...(branch ? { branch } : {}), main: out.length === 0 });
  }
  return out;
}

/** Every checkout of `projectId` reachable from the window's folders: their main trees and linked worktrees. */
export async function checkoutsFor(projectId: string, roots: string[], projects: ProjectResolver): Promise<CheckoutChoice[]> {
  const found: CheckoutChoice[] = [];
  for (const root of roots) {
    const ref = await projects.resolve(root).catch(() => undefined);
    if (ref?.projectId !== projectId) { continue; }
    const list = await git(ref.root, ['worktree', 'list', '--porcelain']);
    const choices = list.ok ? parseWorktrees(list.out) : [{ root: ref.root, main: true }];
    for (const choice of choices) {
      if (!found.some((c) => samePath(c.root, choice.root))) { found.push(choice); }
    }
  }
  return found;
}

export function defaultCheckout(choices: CheckoutChoice[], branch: string | undefined, lastPicked: string | undefined): CheckoutChoice | undefined {
  return (branch ? choices.find((c) => c.branch === branch) : undefined)
    ?? (lastPicked ? choices.find((c) => samePath(c.root, lastPicked)) : undefined)
    ?? choices.find((c) => c.main)
    ?? choices[0];
}

/** The one network git command Marcode runs: fetch the session's branch, then give it a worktree. */
export async function ensureWorktree(mainRoot: string, branch: string): Promise<{ ok: true; root: string } | { ok: false; reason: string }> {
  const fetched = await git(mainRoot, ['fetch', 'origin', branch]);
  if (!fetched.ok) { return { ok: false, reason: fetched.err.trim() || `git fetch origin ${branch} failed` }; }
  const made = await createWorktree(mainRoot, branch, `origin/${branch}`);
  return made.ok ? { ok: true, root: made.path } : { ok: false, reason: made.reason };
}
