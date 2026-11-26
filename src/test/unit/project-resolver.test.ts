import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { git, type GitResult } from '../../host/git-worktree';
import { ProjectResolver } from '../../host/project/project-resolver';
import { ownProjectId } from '../../shared/project-id';

function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function repo(origin?: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-proj-')));
  sh(dir, 'init', '-q');
  sh(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (origin) { sh(dir, 'remote', 'add', 'origin', origin); }
  return dir;
}

suite('ProjectResolver', () => {
  test('a repo resolves to its normalised origin and its root', async () => {
    const dir = await repo('git@github.com:a/b.git');
    assert.deepStrictEqual(await new ProjectResolver([]).resolve(dir), { projectId: 'github.com/a/b', root: dir });
  });

  test('a subfolder resolves to the same ref', async () => {
    const dir = await repo('git@github.com:a/b.git');
    await fs.mkdir(path.join(dir, 'src', 'deep'), { recursive: true });
    assert.deepStrictEqual(
      await new ProjectResolver([]).resolve(path.join(dir, 'src', 'deep')),
      { projectId: 'github.com/a/b', root: dir },
    );
  });

  test('a linked worktree is its own root in the same project', async () => {
    const dir = await repo('git@github.com:a/b.git');
    const wt = path.join(dir, '.worktrees', 'x');
    sh(dir, 'worktree', 'add', '-q', wt, '-b', 'x');
    assert.deepStrictEqual(await new ProjectResolver([]).resolve(wt), { projectId: 'github.com/a/b', root: wt });
  });

  test('SSH and HTTPS clones of one repo share a project', async () => {
    const ssh = await repo('git@github.com:a/b.git');
    const https = await repo('https://github.com/a/b');
    const resolver = new ProjectResolver([]);
    assert.strictEqual((await resolver.resolve(ssh))?.projectId, (await resolver.resolve(https))?.projectId);
  });

  test('no origin, or not a repo, is no project', async () => {
    const bare = await repo();
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-plain-'));
    const resolver = new ProjectResolver([]);
    assert.strictEqual(await resolver.resolve(bare), undefined);
    assert.strictEqual(await resolver.resolve(plain), undefined);
  });

  test('a deleted worktree folder resolves through its nearest existing ancestor', async () => {
    const dir = await repo('git@github.com:a/b.git');
    assert.strictEqual(
      (await new ProjectResolver([]).resolve(path.join(dir, '.worktrees', 'gone', 'sub')))?.projectId,
      'github.com/a/b',
    );
  });

  test("an 'own' override keeps the checkout apart", async () => {
    const dir = await repo('git@github.com:a/b.git');
    const ref = await new ProjectResolver([{ path: dir, project: 'own' }]).resolve(dir);
    assert.strictEqual(ref?.projectId, ownProjectId(dir));
  });

  test('a link override gives a remote-less folder a project', async () => {
    const dir = await repo();
    const ref = await new ProjectResolver([{ path: dir, project: 'github.com/a/b' }]).resolve(dir);
    assert.strictEqual(ref?.projectId, 'github.com/a/b');
  });

  test('a cwd is resolved once, misses included', async () => {
    const dir = await repo('git@github.com:a/b.git');
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-plain-'));
    let calls = 0;
    const counting = (cwd: string, args: string[]): Promise<GitResult> => { calls++; return git(cwd, args); };
    const resolver = new ProjectResolver([], process.platform, counting);
    await resolver.resolve(dir);
    await resolver.resolve(plain);
    const first = calls;
    await resolver.resolve(dir);
    await resolver.resolve(plain);
    assert.strictEqual(calls, first);
  });
});
