import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { ProjectResolver } from '../../host/project/project-resolver';
import { checkoutsFor, defaultCheckout, ensureWorktree } from '../../host/sync/checkouts';
import { SyncState } from '../../sync/sync-state';

const tmp = async (p: string) => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p)));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd, stdio: 'ignore' });

async function repo(remote: string): Promise<string> {
  const dir = await tmp('mar-co-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'i');
  return dir;
}

suite('target checkouts', function () {
  this.timeout(15_000);

  test("the project's main tree and worktrees are listed, another repository's are not", async () => {
    const main = await repo('git@github.com:a/b.git');
    git(main, 'worktree', 'add', '-q', '-b', 'feat/x', path.join(main, '.worktrees', 'feat-x'));
    const other = await repo('git@github.com:c/d.git');
    const list = await checkoutsFor('github.com/a/b', [main, other], new ProjectResolver([]));
    assert.deepStrictEqual(list.map((c) => [path.relative(main, c.root) || '.', c.branch, c.main]), [['.', 'main', true], [path.join('.worktrees', 'feat-x'), 'feat/x', false]]);
  });

  test('the default is the checkout on the session\'s branch, else the last picked, else the main tree', () => {
    const choices = [{ root: '/r', branch: 'main', main: true }, { root: '/r/.worktrees/x', branch: 'x', main: false }, { root: '/r/.worktrees/y', branch: 'y', main: false }];
    assert.strictEqual(defaultCheckout(choices, 'x', '/r/.worktrees/y')?.root, '/r/.worktrees/x');
    assert.strictEqual(defaultCheckout(choices, 'zzz', '/r/.worktrees/y')?.root, '/r/.worktrees/y');
    assert.strictEqual(defaultCheckout(choices, 'zzz', '/gone')?.root, '/r');
    assert.strictEqual(defaultCheckout([], 'x', undefined), undefined);
  });

  test('ensureWorktree fetches a branch that only the remote has and checks it out under .worktrees', async () => {
    const origin = await tmp('mar-co-origin-');
    git(origin, 'init', '-q', '--bare');
    const pusher = await repo(origin);
    git(pusher, 'push', '-q', 'origin', 'main');
    git(pusher, 'checkout', '-q', '-b', 'feat/remote');
    await fs.writeFile(path.join(pusher, 'f.txt'), 'f');
    git(pusher, 'add', '.');
    git(pusher, 'commit', '-q', '-m', 'f');
    git(pusher, 'push', '-q', 'origin', 'feat/remote');
    const target = await tmp('mar-co-target-');
    execFileSync('git', ['clone', '-q', origin, target]);
    const made = await ensureWorktree(target, 'feat/remote');
    assert.strictEqual(made.ok, true);
    assert.strictEqual(made.ok && await fs.readFile(path.join(made.root, 'f.txt'), 'utf8'), 'f');
    const missing = await ensureWorktree(target, 'no/such-branch');
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(!missing.ok && missing.reason.length > 0, true);
  });

  test('the last picked checkout is remembered per project', async () => {
    const state = new SyncState(path.join(await tmp('mar-co-state-'), 's.sqlite'));
    state.setLastCheckout('github.com/a/b', '/r/.worktrees/y');
    assert.strictEqual(state.lastCheckout('github.com/a/b'), '/r/.worktrees/y');
    assert.strictEqual(state.lastCheckout('github.com/c/d'), undefined);
    state.close();
  });
});
