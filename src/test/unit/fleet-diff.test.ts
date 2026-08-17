// Fleet diff's git plumbing: what changed in a tree, and against what.
//
// Real git, real repositories, no mocking — the same rule the stale-tree
// sweep sets. A diff answered from a mock would be answering about a
// repository nobody has.

import * as assert from 'assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseNumstat, resolveBase, treeChanges } from '../../host/fleet-diff';

const run = promisify(execFile);
const roots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'hiiiid-fdiff-')));
  roots.push(dir);
  return dir;
}

async function initRepo(dir: string): Promise<void> {
  await run('git', ['init', '-b', 'main', dir], { windowsHide: true });
  await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir, windowsHide: true });
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir, windowsHide: true });
  await run('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, windowsHide: true });
  await fs.writeFile(join(dir, 'README.md'), 'seed\n');
  await run('git', ['add', 'README.md'], { cwd: dir, windowsHide: true });
  await run('git', ['commit', '-m', 'seed'], { cwd: dir, windowsHide: true });
}

async function commitAll(dir: string, message: string): Promise<void> {
  await run('git', ['add', '-A'], { cwd: dir, windowsHide: true });
  await run('git', ['commit', '-m', message], { cwd: dir, windowsHide: true });
}

suite('fleet-diff git plumbing', function () {
  this.timeout(60_000);

  teardown(async () => {
    while (roots.length > 0) {
      await fs.rm(roots.pop()!, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test('parseNumstat reads counts, renames and binary files', () => {
    const rows = parseNumstat([
      '3\t1\tsrc/a.ts',
      '0\t7\tsrc/gone.ts',
      '-\t-\tassets/logo.png',
      '2\t2\tsrc/{old => new}.ts',
    ].join('\n'));

    assert.strictEqual(rows.length, 4);
    assert.strictEqual(rows[0].path, 'src/a.ts');
    assert.strictEqual(rows[0].insertions, 3);
    assert.strictEqual(rows[0].deletions, 1);
    assert.strictEqual(rows[2].insertions, undefined);
    assert.strictEqual(rows[2].deletions, undefined);
    assert.strictEqual(rows[3].op, 'rename');
    assert.strictEqual(rows[3].from, 'src/old.ts');
    assert.strictEqual(rows[3].path, 'src/new.ts');
  });

  test('a repo with no remote and no other branch falls back to head', async () => {
    const dir = await tempDir();
    await initRepo(dir);
    const base = await resolveBase(dir);
    assert.strictEqual(base.kind, 'head');
  });

  test('committed and uncommitted changes arrive merged, in one answer', async () => {
    const dir = await tempDir();
    await initRepo(dir);
    await run('git', ['checkout', '-b', 'work'], { cwd: dir, windowsHide: true });
    await fs.writeFile(join(dir, 'committed.ts'), 'a\n');
    await commitAll(dir, 'work');
    await fs.writeFile(join(dir, 'dirty.ts'), 'b\n');

    const result = await treeChanges(dir);
    assert.strictEqual('reason' in result, false);
    if ('reason' in result) { return; }
    assert.strictEqual(result.base.kind, 'merge-base');
    const paths = result.files.map((f) => f.path).sort();
    assert.deepStrictEqual(paths, ['committed.ts', 'dirty.ts']);
  });

  test('an untracked file is a create, with no counts', async () => {
    const dir = await tempDir();
    await initRepo(dir);
    await fs.writeFile(join(dir, 'brand-new.ts'), 'x\n');

    const result = await treeChanges(dir);
    if ('reason' in result) { assert.fail(result.reason); }
    const row = result.files.find((f) => f.path === 'brand-new.ts');
    assert.strictEqual(row?.op, 'create');
    assert.strictEqual(row?.insertions, undefined);
  });

  test('a non-ASCII path is not octal-escaped', async () => {
    const dir = await tempDir();
    await initRepo(dir);
    await fs.writeFile(join(dir, 'café.ts'), 'x\n');

    const result = await treeChanges(dir);
    if ('reason' in result) { assert.fail(result.reason); }
    assert.strictEqual(result.files.some((f) => f.path === 'café.ts'), true);
  });

  test('a directory that is not a repository answers with a reason', async () => {
    const dir = await tempDir();
    const result = await treeChanges(dir);
    assert.strictEqual('reason' in result, true);
  });

  test('the file cap reports what it omitted', async () => {
    const dir = await tempDir();
    await initRepo(dir);
    for (let i = 0; i < 505; i++) {
      await fs.writeFile(join(dir, `f${i}.ts`), 'x\n');
    }
    const result = await treeChanges(dir);
    if ('reason' in result) { assert.fail(result.reason); }
    assert.strictEqual(result.files.length, 500);
    assert.strictEqual(result.omitted, 5);
  });
});
