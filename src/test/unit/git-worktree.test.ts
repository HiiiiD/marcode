// These tests build real git repositories in a temp directory and run the real
// `git` binary against them. Nothing here is mocked: the whole value of
// `git-worktree.ts` is that its refusals match what git actually does, and a
// stubbed `execFile` would only ever confirm the stub.

import * as assert from 'assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { bringBack, bringBackPlan, createWorktree, treeStatus } from '../../host/git-worktree';

const run = promisify(execFile);

const roots: string[] = [];

/**
 * A fresh temp directory. `realpath` matters on Windows, where `os.tmpdir()`
 * routinely resolves through a short (`RUNNER~1`) or redirected path and git
 * reports the real one — comparing the two forms fails confusingly.
 */
async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'mar-git-')));
  roots.push(dir);
  return dir;
}

/**
 * Repo-local identity and `commit.gpgsign=false`: the machine's global config
 * may be missing (git then refuses to commit) or may sign, and a signing
 * prompt would hang the suite with no output.
 */
async function initRepo(dir: string): Promise<void> {
  await run('git', ['init', '-b', 'main', dir], { windowsHide: true });
  await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir, windowsHide: true });
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir, windowsHide: true });
  await run('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, windowsHide: true });
  await fs.writeFile(join(dir, 'README.md'), 'seed\n');
  await run('git', ['add', 'README.md'], { cwd: dir, windowsHide: true });
  await run('git', ['commit', '-m', 'seed'], { cwd: dir, windowsHide: true });
}

/** A repository with one commit, so HEAD exists and branches can be made. */
async function tempRepo(): Promise<string> {
  const repo = join(await tempDir(), 'repo');
  await fs.mkdir(repo, { recursive: true });
  await initRepo(repo);
  return repo;
}

/** That repository plus a linked worktree at `<container>/trees/<branch>`. */
async function tempRepoWithWorktree(branch: string): Promise<{ repo: string; tree: string }> {
  const container = await tempDir();
  const repo = join(container, 'repo');
  await fs.mkdir(repo, { recursive: true });
  await initRepo(repo);
  const tree = join(container, 'trees', branch);
  await run('git', ['worktree', 'add', tree, '-b', branch], { cwd: repo, windowsHide: true });
  return { repo, tree: resolve(tree) };
}

suite('git-worktree', function () {
  // Real git, real filesystem: the 2s mocha default is not enough on Windows.
  this.timeout(60_000);

  teardown(async () => {
    while (roots.length > 0) {
      await fs.rm(roots.pop()!, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test('reports a non-repository', async () => {
    const dir = await tempDir();
    assert.strictEqual((await treeStatus(dir)).isRepo, false);
  });

  test('reports a clean repository and its branch', async () => {
    const repo = await tempRepo();
    const status = await treeStatus(repo);
    assert.strictEqual(status.isRepo, true);
    assert.strictEqual(status.clean, true);
    assert.strictEqual(status.branch, 'main');
    assert.strictEqual(status.root, repo);
    assert.strictEqual(status.isWorktree, false);
  });

  test('reports a dirty repository', async () => {
    const repo = await tempRepo();
    await fs.writeFile(join(repo, 'dirty.txt'), 'x');
    assert.strictEqual((await treeStatus(repo)).clean, false);
  });

  test('identifies a worktree and its main root', async () => {
    const { tree, repo } = await tempRepoWithWorktree('feat-x');
    const status = await treeStatus(tree);
    assert.strictEqual(status.isWorktree, true);
    assert.strictEqual(status.mainRoot, repo);
    assert.strictEqual(status.branch, 'feat-x');
  });

  test('plans a bring-back for a clean pair', async () => {
    const { tree, repo } = await tempRepoWithWorktree('feat-x');
    const plan = await bringBackPlan(tree);
    assert.strictEqual(plan.ok, true);
    assert.strictEqual(plan.ok === true && plan.branch, 'feat-x');
    assert.strictEqual(plan.ok === true && plan.worktree, tree);
    assert.strictEqual(plan.ok === true && plan.mainRoot, repo);
  });

  test('refuses when the main tree is dirty, and says which', async () => {
    const { tree, repo } = await tempRepoWithWorktree('feat-x');
    await fs.writeFile(join(repo, 'dirty.txt'), 'x');
    const plan = await bringBackPlan(tree);
    assert.strictEqual(plan.ok, false);
    assert.strictEqual(plan.ok === false && plan.reason.includes('main'), true);
  });

  test('refuses when the worktree is dirty, and says which', async () => {
    const { tree } = await tempRepoWithWorktree('feat-x');
    await fs.writeFile(join(tree, 'dirty.txt'), 'x');
    const plan = await bringBackPlan(tree);
    assert.strictEqual(plan.ok, false);
    assert.strictEqual(plan.ok === false && plan.reason.includes('worktree'), true);
  });

  test('refuses for a directory that is not a worktree', async () => {
    const repo = await tempRepo();
    assert.strictEqual((await bringBackPlan(repo)).ok, false);
  });

  test('refuses for a detached worktree head', async () => {
    const { tree } = await tempRepoWithWorktree('feat-x');
    await run('git', ['checkout', '--detach'], { cwd: tree, windowsHide: true });
    const plan = await bringBackPlan(tree);
    assert.strictEqual(plan.ok, false);
    assert.strictEqual(plan.ok === false && plan.reason.includes('branch'), true);
  });

  test('removes the tree and checks the branch out in the main root', async () => {
    const { tree, repo } = await tempRepoWithWorktree('feat-x');
    const plan = await bringBackPlan(tree);
    assert.strictEqual(plan.ok, true);
    const result = await bringBack(plan as Extract<typeof plan, { ok: true }>);
    assert.strictEqual(result.ok, true);
    assert.strictEqual((await treeStatus(repo)).branch, 'feat-x');
    let treeGone = false;
    try { await fs.stat(tree); } catch { treeGone = true; }
    assert.strictEqual(treeGone, true);
  });

  // The race Task 10's re-plan exists for: the tree was clean when the plan was
  // made and dirty by the time the user confirmed. git refuses the removal, and
  // that refusal has to arrive as a reason rather than an unhandled rejection.
  test('reports a reason instead of throwing when a git step fails', async () => {
    const { tree, repo } = await tempRepoWithWorktree('feat-x');
    const plan = await bringBackPlan(tree);
    assert.strictEqual(plan.ok, true);
    await fs.writeFile(join(tree, 'README.md'), 'edited after planning\n');
    const result = await bringBack(plan as Extract<typeof plan, { ok: true }>);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(typeof result.reason === 'string' && result.reason.length > 0, true);
    assert.strictEqual((await treeStatus(repo)).branch, 'main');
  });

  suite('createWorktree', () => {
    test('creates a new branch off HEAD when no base is given', async () => {
      const repo = await tempRepo();
      const result = await createWorktree(repo, 'feat-y');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(
        result.ok && resolve(result.path),
        resolve(join(repo, '.worktrees', 'feat-y')),
      );
      const status = await treeStatus(result.ok ? result.path : '');
      assert.strictEqual(status.isWorktree, true);
      assert.strictEqual(status.branch, 'feat-y');
      assert.strictEqual(status.mainRoot, repo);
    });

    test('creates a new branch off an explicit base', async () => {
      const repo = await tempRepo();
      await run('git', ['branch', 'base-branch'], { cwd: repo, windowsHide: true });
      await fs.writeFile(join(repo, 'on-base.txt'), 'x');
      await run('git', ['add', 'on-base.txt'], { cwd: repo, windowsHide: true });
      await run('git', ['commit', '-m', 'on base'], { cwd: repo, windowsHide: true });
      // main now has a commit base-branch does not: prove the new worktree
      // branched off base-branch, not off HEAD.
      const result = await createWorktree(repo, 'feat-z', 'base-branch');
      assert.strictEqual(result.ok, true);
      let hasOnBase = false;
      try { await fs.stat(join(result.ok ? result.path : '', 'on-base.txt')); hasOnBase = true; } catch { /* absent */ }
      assert.strictEqual(hasOnBase, false);
    });

    test('checks out an already-existing branch instead of recreating it', async () => {
      const repo = await tempRepo();
      await run('git', ['branch', 'feat-existing'], { cwd: repo, windowsHide: true });
      const result = await createWorktree(repo, 'feat-existing');
      assert.strictEqual(result.ok, true);
      const status = await treeStatus(result.ok ? result.path : '');
      assert.strictEqual(status.branch, 'feat-existing');
    });

    test('sanitizes slashes in the branch name into the worktree directory', async () => {
      const repo = await tempRepo();
      const result = await createWorktree(repo, 'feat/nested');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(
        result.ok && resolve(result.path),
        resolve(join(repo, '.worktrees', 'feat-nested')),
      );
      const status = await treeStatus(result.ok ? result.path : '');
      assert.strictEqual(status.branch, 'feat/nested');
    });

    test('reports a reason instead of throwing when git refuses', async () => {
      const repo = await tempRepo();
      const first = await createWorktree(repo, 'feat-dup');
      assert.strictEqual(first.ok, true);
      // Second call reuses the same branch, which is already checked out in a
      // worktree — git refuses to check the same branch out twice.
      const second = await createWorktree(repo, 'feat-dup');
      assert.strictEqual(second.ok, false);
      assert.strictEqual(second.ok === false && second.reason.length > 0, true);
    });
  });
});
