import { git } from '../git-worktree';

/** Whether a checkout's work is all on its remote: no uncommitted files, nothing ahead of its upstream. */
export async function pushedState(cwd: string): Promise<{ modified: number; unpushed: number; upstream: boolean }> {
  const status = await git(cwd, ['status', '--porcelain']);
  const modified = status.ok ? status.out.split('\n').filter((l) => l.trim() !== '').length : 0;
  const upstream = (await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).ok;
  const ahead = upstream ? await git(cwd, ['rev-list', '--count', '@{u}..HEAD']) : undefined;
  return { modified, unpushed: ahead?.ok ? Number(ahead.out.trim()) || 0 : 0, upstream };
}
