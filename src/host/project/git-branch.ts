import { git } from '../git-worktree';

/** The checked-out branch, or `undefined` for a detached head or a folder that is not a repo. */
export async function gitBranch(cwd: string): Promise<string | undefined> {
  const result = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = result.out.trim();
  return result.ok && name !== '' && name !== 'HEAD' ? name : undefined;
}
