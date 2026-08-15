// The stale-tree sweep: every working tree this panel still touches, and
// whether it can go.
//
// Real git, real repositories, no mocking — the same rule Tasks 9 and 10 set.
// A sweep that answered from a mock would be answering about a repository
// nobody has, and the whole value of this surface is that its refusals are
// git's own.

import * as assert from 'assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { HostToWebview, StaleTree } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';

const run = promisify(execFile);

const roots: string[] = [];
const managers: SessionManager[] = [];

/** See Task 9's suite: `realpath` matters on Windows, where tmpdir is short. */
async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'hiiiid-stale-')));
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

/**
 * A repository with one linked worktree and one live session sitting in that
 * worktree, with a completed turn behind it.
 */
async function panelInWorktree(branch: string) {
  const container = await tempDir();
  const repo = join(container, 'repo');
  await fs.mkdir(repo, { recursive: true });
  await initRepo(repo);
  const tree = resolve(join(container, 'trees', branch));
  await run('git', ['worktree', 'add', tree, '-b', branch], { cwd: repo, windowsHide: true });

  const storage = await tempDir();
  const store = new TranscriptStore(storage);
  const provider = new FakeProvider(() => [
    { kind: 'text', delta: 'ok' },
    { kind: 'turn-end', reason: 'done' },
  ]);
  const providers = new Map<string, AgentProvider>([['fake', provider]]);
  const emitted: HostToWebview[] = [];
  const manager = new SessionManager(store, providers, (m) => emitted.push(m));
  managers.push(manager);
  await manager.init();

  const session = await manager.create('fake', tree);
  session.send('plan the feature');
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }

  return { manager, session, store, emitted: () => emitted, container, repo, tree };
}

/** Adds a second linked worktree to `repo` and returns its resolved path. */
async function addTree(repo: string, branch: string): Promise<string> {
  const tree = resolve(join(repo, '..', 'trees', branch));
  await run('git', ['worktree', 'add', tree, '-b', branch], { cwd: repo, windowsHide: true });
  return tree;
}

function rowFor(trees: StaleTree[], path: string): StaleTree | undefined {
  return trees.find((t) => t.path.toLowerCase() === path.toLowerCase());
}

async function exists(path: string): Promise<boolean> {
  try { await fs.stat(path); return true; } catch { return false; }
}

suite('SessionManager.staleTrees', function () {
  // Real git, real filesystem: the 2s mocha default is nowhere near enough.
  this.timeout(60_000);

  teardown(async () => {
    while (managers.length > 0) { await managers.pop()!.dispose(); }
    while (roots.length > 0) {
      await fs.rm(roots.pop()!, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test('the tree a session is sitting in is listed, and names its session', async () => {
    const { manager, session, tree } = await panelInWorktree('feat-x');
    const row = rowFor(await manager.staleTrees(), tree);
    assert.strictEqual(row?.branch, 'feat-x');
    assert.strictEqual(row?.clean, true);
    assert.strictEqual(row?.sessionId, session.state.id);
    assert.strictEqual(row?.reason, undefined);
  });

  // The point of the whole surface: a tree the session has walked out of has
  // no pane header left to offer the bring-back door from.
  test('a tree only a resume token remembers is listed, and is unowned', async () => {
    const { manager, session, repo } = await panelInWorktree('feat-x');
    const abandoned = await addTree(repo, 'feat-y');
    session.state.resumeTokens[`fake:${abandoned}`] = 'left-behind';

    const row = rowFor(await manager.staleTrees(), abandoned);
    assert.strictEqual(row?.branch, 'feat-y');
    assert.strictEqual(row?.sessionId, undefined);
  });

  // A `'global'`-scope key is a bare provider id. Reading it as a path would
  // put a row named `fake` in the sweep, offering to delete a directory that
  // was never one.
  test('a global-scope resume key is not a directory', async () => {
    const { manager, session } = await panelInWorktree('feat-x');
    session.state.resumeTokens['fake'] = 'global-thread';
    const trees = await manager.staleTrees();
    assert.strictEqual(trees.some((t) => t.path.endsWith('fake')), false);
  });

  // The main tree is where a branch comes *back* to. Listing it in a sweep
  // whose only action can refuse would be a row that exists to say no.
  test('the main working tree is not a row', async () => {
    const { manager, session, repo } = await panelInWorktree('feat-x');
    session.state.resumeTokens[`fake:${repo}`] = 'main-thread';
    const trees = await manager.staleTrees();
    assert.strictEqual(rowFor(trees, repo) === undefined, true);
  });

  test('a dirty tree carries the refusal that would stop its removal', async () => {
    const { manager, tree } = await panelInWorktree('feat-x');
    await fs.writeFile(join(tree, 'scratch.txt'), 'x');
    const row = rowFor(await manager.staleTrees(), tree);
    assert.strictEqual(row?.clean, false);
    assert.strictEqual((row?.reason ?? '').includes('uncommitted'), true);
  });

  test('the sweep is emitted as one panel-wide message', async () => {
    const { manager, emitted, tree } = await panelInWorktree('feat-x');
    await manager.requestStaleTrees();
    const msg = emitted().find((m) => m.t === 'stale-trees');
    assert.strictEqual(msg !== undefined, true);
    assert.strictEqual(
      msg?.t === 'stale-trees' && rowFor(msg.trees, tree) !== undefined,
      true,
    );
  });
});

suite('SessionManager.removeStaleTree', function () {
  this.timeout(60_000);

  teardown(async () => {
    while (managers.length > 0) { await managers.pop()!.dispose(); }
    while (roots.length > 0) {
      await fs.rm(roots.pop()!, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test('an unowned tree goes, and stops being a row', async () => {
    const { manager, session, repo } = await panelInWorktree('feat-x');
    const abandoned = await addTree(repo, 'feat-y');
    session.state.resumeTokens[`fake:${abandoned}`] = 'left-behind';

    await manager.removeStaleTree(abandoned);
    assert.strictEqual(await exists(abandoned), false);
    assert.strictEqual(rowFor(await manager.staleTrees(), abandoned) === undefined, true);
  });

  test('removing a tree drops every token that could resume into it', async () => {
    const { manager, session, repo } = await panelInWorktree('feat-x');
    const abandoned = await addTree(repo, 'feat-y');
    session.state.resumeTokens[`fake:${abandoned}`] = 'left-behind';

    await manager.removeStaleTree(abandoned);
    assert.strictEqual(
      Object.keys(session.state.resumeTokens).includes(`fake:${abandoned}`),
      false,
    );
  });

  // Not a second implementation of the move: the occupied case is the pane
  // header's bring-back, reached from a different door.
  test('an occupied tree takes its session home with it', async () => {
    const { manager, session, repo, tree } = await panelInWorktree('feat-x');
    await manager.removeStaleTree(tree);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd, repo);
    assert.strictEqual(await exists(tree), false);
  });

  test('a dirty tree is refused, and the refreshed sweep says why', async () => {
    const { manager, session, emitted, repo } = await panelInWorktree('feat-x');
    const abandoned = await addTree(repo, 'feat-y');
    session.state.resumeTokens[`fake:${abandoned}`] = 'left-behind';
    await fs.writeFile(join(abandoned, 'scratch.txt'), 'x');

    await manager.removeStaleTree(abandoned);
    assert.strictEqual(await exists(abandoned), true);
    const last = [...emitted()].reverse().find((m) => m.t === 'stale-trees');
    const row = last?.t === 'stale-trees' ? rowFor(last.trees, abandoned) : undefined;
    assert.strictEqual((row?.reason ?? '').includes('uncommitted'), true);
  });

  // The one state `bringBackPlan` cannot see: `status --porcelain` is clean,
  // so only git's own refusal at the moment of removal catches it.
  test('a git refusal at the moment of removal is carried into the sweep', async () => {
    const { manager, session, emitted, repo } = await panelInWorktree('feat-x');
    const abandoned = await addTree(repo, 'feat-y');
    session.state.resumeTokens[`fake:${abandoned}`] = 'left-behind';
    await run('git', ['worktree', 'lock', abandoned], { cwd: repo, windowsHide: true });

    await manager.removeStaleTree(abandoned);
    assert.strictEqual(await exists(abandoned), true);
    const last = [...emitted()].reverse().find((m) => m.t === 'stale-trees');
    const row = last?.t === 'stale-trees' ? rowFor(last.trees, abandoned) : undefined;
    assert.strictEqual((row?.reason ?? '').toLowerCase().includes('remove'), true);
  });

  test('a path the panel does not know is not swept', async () => {
    const { manager, repo } = await panelInWorktree('feat-x');
    const stranger = await addTree(repo, 'feat-z');
    await manager.removeStaleTree(stranger);
    assert.strictEqual(await exists(stranger), true);
  });
});
