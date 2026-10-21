import { treeStatus } from '../git-worktree';

/** The session's git root, or its cwd outside a repo. */
export async function resolveRepoRoot(cwd: string): Promise<string> {
  const status = await treeStatus(cwd);
  return status.isRepo ? status.root : cwd;
}
