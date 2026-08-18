// Bringing a worktree's branch back into the main tree, from the manager down.
//
// Real git, real repositories, no mocking — the same rule Task 9's suite set.
// The whole point of this feature is that its refusals match what git actually
// does, and every refusal here is a *product* behaviour, not error handling:
// the session must be exactly where it was, with a record of why.

import * as assert from 'assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { HostToWebview } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';

const run = promisify(execFile);

const roots: string[] = [];
const managers: SessionManager[] = [];

/** See Task 9's suite: `realpath` matters on Windows, where tmpdir is short. */
async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'mar-bring-')));
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
 * A live session whose cwd is a linked worktree of a real repository, with one
 * turn of history behind it so the transcript is not empty.
 */
async function sessionInWorktree(branch: string) {
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

  return { manager, session, store, emitted: () => emitted, repo, tree };
}

async function errorMessages(store: TranscriptStore, id: string): Promise<string[]> {
  const { items } = await store.tail(id, 500);
  return items.flatMap((i) => (i.role === 'error' ? [i.message] : []));
}

suite('SessionManager.bringBack', function () {
  // Real git, real filesystem: the 2s mocha default is nowhere near enough.
  this.timeout(60_000);

  teardown(async () => {
    while (managers.length > 0) { await managers.pop()!.dispose(); }
    while (roots.length > 0) {
      await fs.rm(roots.pop()!, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test('emits a plan describing the two steps', async () => {
    const { manager, session, emitted } = await sessionInWorktree('feat-x');
    await manager.requestBringBack(session.state.id);
    const msg = emitted().find((m) => m.t === 'bring-back-plan');
    assert.strictEqual(msg !== undefined, true);
    assert.strictEqual(msg?.t === 'bring-back-plan' && msg.plan.ok, true);
  });

  test('a plan for a session outside a worktree says so, so the UI can hide the door', async () => {
    const { manager, session, emitted, repo } = await sessionInWorktree('feat-x');
    session.state.cwd = repo;
    await manager.requestBringBack(session.state.id);
    const msg = emitted().find((m) => m.t === 'bring-back-plan');
    assert.strictEqual(
      msg?.t === 'bring-back-plan' && msg.plan.ok === false && msg.plan.isWorktree,
      false,
    );
  });

  test('refuses and does not move the session when the main tree is dirty', async () => {
    const { manager, session, store, repo } = await sessionInWorktree('feat-x');
    await fs.writeFile(join(repo, 'dirty.txt'), 'x');
    const before = session.state.cwd;
    await manager.bringBack(session.state.id);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd, before);
    const errors = await errorMessages(store, session.state.id);
    assert.strictEqual(errors.some((m) => m.includes('main')), true);
  });

  test('on success the worktree is gone and the session sits in the main root', async () => {
    const { manager, session, repo, tree } = await sessionInWorktree('feat-x');
    await manager.bringBack(session.state.id);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd, repo);
    let gone = false;
    try { await fs.stat(tree); } catch { gone = true; }
    assert.strictEqual(gone, true);
  });

  test('the departing tree stops being a directory anything can resume into', async () => {
    const { manager, session, tree } = await sessionInWorktree('feat-x');
    session.state.resumeTokens[`fake:${tree}`] = 'stale-token';
    await manager.bringBack(session.state.id);
    const tokens = manager.get(session.state.id)!.state.resumeTokens;
    assert.strictEqual(Object.keys(tokens).includes(`fake:${tree}`), false);
  });

  // The dialog can sit open for minutes. What it was shown is not what the
  // host may act on, so the plan is recomputed at the moment of the click.
  test('re-plans at the click: a tree dirtied since the dialog opened is refused', async () => {
    const { manager, session, store, tree } = await sessionInWorktree('feat-x');
    await manager.requestBringBack(session.state.id);
    await fs.writeFile(join(tree, 'dirty.txt'), 'x');
    const before = session.state.cwd;
    await manager.bringBack(session.state.id);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd, before);
    const errors = await errorMessages(store, session.state.id);
    assert.strictEqual(errors.some((m) => m.includes('uncommitted')), true);
  });

  // Git first, cwd second. A locked worktree is the one state git refuses to
  // remove while `bringBackPlan` still says yes — `status --porcelain` is
  // clean, so the re-plan above cannot catch it. That makes this the only
  // fixture that genuinely reaches the failed-git-step branch.
  test('a git step that fails leaves the session exactly where it was', async () => {
    const { manager, session, store, tree } = await sessionInWorktree('feat-x');
    await run('git', ['worktree', 'lock', tree], { cwd: tree, windowsHide: true });
    const before = session.state.cwd;
    await manager.bringBack(session.state.id);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd, before);
    let stillThere = true;
    try { await fs.stat(tree); } catch { stillThere = false; }
    assert.strictEqual(stillThere, true);
    const errors = await errorMessages(store, session.state.id);
    assert.strictEqual(errors.some((m) => m.toLowerCase().includes('remove')), true);
  });

  test('a turn in flight finishes in the tree it started in', async () => {
    const { manager, session, tree } = await sessionInWorktree('feat-x');
    session.state.status = 'running';
    await manager.bringBack(session.state.id);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd, tree);
  });
});
