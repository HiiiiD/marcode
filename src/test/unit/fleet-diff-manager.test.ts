// Attribution: which session wrote which file, from the transcript rather
// than from git — because git sees one dirty tree when three sessions share
// a root, and the panel is the only thing that knows more.

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

async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'hiiiid-claims-')));
  roots.push(dir);
  return dir;
}

/** Drains the fake provider's synchronous event queue. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

async function managerWith(script: ConstructorParameters<typeof FakeProvider>[0]) {
  const storage = await tempDir();
  const store = new TranscriptStore(storage);
  const providers = new Map<string, AgentProvider>([['fake', new FakeProvider(script)]]);
  const emitted: HostToWebview[] = [];
  const manager = new SessionManager(store, providers, (m) => emitted.push(m));
  managers.push(manager);
  await manager.init();
  return { manager, store, emitted: () => emitted };
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

/** A provider script that claims `path` and then ends the turn. */
function claims(path: string) {
  return () => [
    { kind: 'tool-start' as const, id: 't1', tool: { kind: 'file-edit' as const, label: 'Edit', files: [{ path, op: 'modify' as const }] } },
    { kind: 'tool-end' as const, id: 't1', ok: true, output: { kind: 'none' as const } },
    { kind: 'turn-end' as const, reason: 'done' as const },
  ];
}

suite('AgentSession claimed paths', function () {
  this.timeout(30_000);

  teardown(async () => {
    while (managers.length > 0) { await managers.pop()!.dispose(); }
    while (roots.length > 0) {
      await fs.rm(roots.pop()!, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test('a file edit is claimed, absolute, resolved against the session cwd', async () => {
    const { manager } = await managerWith(() => [
      { kind: 'tool-start', id: 't1', tool: { kind: 'file-edit', label: 'Edit', files: [{ path: 'src/a.ts', op: 'modify' }] } },
      { kind: 'tool-end', id: 't1', ok: true, output: { kind: 'none' } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const cwd = await tempDir();
    const session = await manager.create('fake', cwd);
    session.send('edit it');
    await settle();

    assert.deepStrictEqual([...session.claimedPaths], [resolve(cwd, 'src/a.ts')]);
  });

  test("a subagent's edit is claimed by the parent session", async () => {
    const { manager } = await managerWith(() => [
      { kind: 'tool-start', id: 'p1', tool: { kind: 'subagent', label: 'Task', action: 'spawn' } },
      { kind: 'tool-start', id: 'c1', parentId: 'p1', tool: { kind: 'file-edit', label: 'Edit', files: [{ path: 'sub.ts', op: 'modify' }] } },
      { kind: 'tool-end', id: 'c1', ok: true, output: { kind: 'none' } },
      { kind: 'tool-end', id: 'p1', ok: true, output: { kind: 'none' } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const cwd = await tempDir();
    const session = await manager.create('fake', cwd);
    session.send('delegate it');
    await settle();

    assert.strictEqual(session.claimedPaths.has(resolve(cwd, 'sub.ts')), true);
  });

  test('a failed edit is still a claim, because the file may still have moved', async () => {
    const { manager } = await managerWith(() => [
      { kind: 'tool-start', id: 't1', tool: { kind: 'file-edit', label: 'Edit', files: [{ path: 'x.ts', op: 'modify' }] } },
      { kind: 'tool-end', id: 't1', ok: false, output: { kind: 'text', text: 'boom' } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const cwd = await tempDir();
    const session = await manager.create('fake', cwd);
    session.send('try it');
    await settle();

    assert.strictEqual(session.claimedPaths.has(resolve(cwd, 'x.ts')), true);
  });

  test('a command claims nothing', async () => {
    const { manager } = await managerWith(() => [
      { kind: 'tool-start', id: 't1', tool: { kind: 'command', label: 'Bash', command: 'ls' } },
      { kind: 'tool-end', id: 't1', ok: true, output: { kind: 'text', text: '' } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = await manager.create('fake', await tempDir());
    session.send('list it');
    await settle();

    assert.strictEqual(session.claimedPaths.size, 0);
  });
});

suite('SessionManager.fleetDiff', function () {
  this.timeout(60_000);

  teardown(async () => {
    while (managers.length > 0) { await managers.pop()!.dispose(); }
    while (roots.length > 0) {
      await fs.rm(roots.pop()!, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test('a changed file is listed and attributed to the session that wrote it', async () => {
    const repo = await tempDir();
    await initRepo(repo);
    const { manager } = await managerWith(claims('feature.ts'));
    const session = await manager.create('fake', repo);
    await manager.setVisible([session.state.id]);
    session.send('write it');
    await settle();
    await fs.writeFile(join(repo, 'feature.ts'), 'hello\n');

    const trees = await manager.fleetDiff();
    assert.strictEqual(trees.length, 1);
    const row = trees[0].files.find((f) => f.path === 'feature.ts');
    assert.deepStrictEqual(row?.claimedBy, [session.state.id]);
  });

  test('a change nobody claimed is listed with an empty claim set', async () => {
    const repo = await tempDir();
    await initRepo(repo);
    const { manager } = await managerWith(() => [{ kind: 'turn-end', reason: 'done' }]);
    const session = await manager.create('fake', repo);
    await manager.setVisible([session.state.id]);
    await settle();
    // Made by a shell command, a build, or the user — no tool call behind it.
    await fs.writeFile(join(repo, 'by-hand.ts'), 'x\n');

    const trees = await manager.fleetDiff();
    const row = trees[0].files.find((f) => f.path === 'by-hand.ts');
    assert.deepStrictEqual(row?.claimedBy, []);
  });

  test('two sessions in one tree produce one row naming both', async () => {
    const repo = await tempDir();
    await initRepo(repo);
    const { manager } = await managerWith(claims('shared.ts'));
    const a = await manager.create('fake', repo);
    const b = await manager.create('fake', repo);
    await manager.setVisible([a.state.id, b.state.id]);
    a.send('go');
    await settle();
    b.send('go');
    await settle();
    await fs.writeFile(join(repo, 'shared.ts'), 'x\n');

    const trees = await manager.fleetDiff();
    assert.strictEqual(trees.length, 1);
    assert.strictEqual(trees[0].sessions.length, 2);
    const row = trees[0].files.find((f) => f.path === 'shared.ts');
    assert.strictEqual(row?.claimedBy.length, 2);
  });

  test('a claim for a path outside the tree is dropped', async () => {
    const repo = await tempDir();
    await initRepo(repo);
    const elsewhere = await tempDir();
    const { manager } = await managerWith(claims(join(elsewhere, 'stray.ts').split('\\').join('/')));
    const session = await manager.create('fake', repo);
    await manager.setVisible([session.state.id]);
    session.send('go');
    await settle();
    await fs.writeFile(join(repo, 'real.ts'), 'x\n');

    const trees = await manager.fleetDiff();
    const row = trees[0].files.find((f) => f.path === 'real.ts');
    assert.deepStrictEqual(row?.claimedBy, []);
  });

  test('a tree with no visible pane is omitted, even with a claimed change', async () => {
    const repo = await tempDir();
    await initRepo(repo);
    const { manager } = await managerWith(claims('hidden.ts'));
    const session = await manager.create('fake', repo);
    // Never made visible: no pane is open for it.
    session.send('go');
    await settle();
    await fs.writeFile(join(repo, 'hidden.ts'), 'x\n');

    assert.deepStrictEqual(await manager.fleetDiff(), []);
  });

  test('two sessions share a tree; only the visible one keeps it listed', async () => {
    const repo = await tempDir();
    await initRepo(repo);
    const { manager } = await managerWith(claims('shared.ts'));
    const a = await manager.create('fake', repo);
    const b = await manager.create('fake', repo);
    await manager.setVisible([a.state.id]);
    a.send('go');
    await settle();
    b.send('go');
    await settle();
    await fs.writeFile(join(repo, 'shared.ts'), 'x\n');

    const trees = await manager.fleetDiff();
    assert.strictEqual(trees.length, 1);
    assert.deepStrictEqual(trees[0].sessions, [a.state.id]);
  });

  test('a session in a plain directory is not a tree at all', async () => {
    const plain = await tempDir();
    const { manager } = await managerWith(() => [{ kind: 'turn-end', reason: 'done' }]);
    await manager.create('fake', plain);

    assert.deepStrictEqual(await manager.fleetDiff(), []);
  });

  test('claims survive a session being closed and reopened, via the transcript', async () => {
    const repo = await tempDir();
    await initRepo(repo);
    const { manager } = await managerWith(claims('restored.ts'));
    const session = await manager.create('fake', repo);
    const id = session.state.id;
    await manager.setVisible([id]);
    session.send('go');
    await settle();
    await manager.close(id);
    await manager.open(id);
    await manager.setVisible([id]);
    await fs.writeFile(join(repo, 'restored.ts'), 'x\n');

    const trees = await manager.fleetDiff();
    const row = trees[0].files.find((f) => f.path === 'restored.ts');
    assert.deepStrictEqual(row?.claimedBy, [id]);
  });

  test('requestFleetDiff emits the trees on the wire', async () => {
    const repo = await tempDir();
    await initRepo(repo);
    const { manager, emitted } = await managerWith(() => [{ kind: 'turn-end', reason: 'done' }]);
    const session = await manager.create('fake', repo);
    await manager.setVisible([session.state.id]);
    await manager.requestFleetDiff();

    const msg = emitted().filter((m) => m.t === 'fleet-diff').pop();
    assert.strictEqual(msg?.t, 'fleet-diff');
  });

  test('a failed read answers with a reason rather than rejecting', async () => {
    // Errors are state, never exceptions: a rejection here would leave the
    // surface on "Reading the working trees…" forever, since the message that
    // replaces that sentence is the one that never got sent.
    const { manager, emitted } = await managerWith(() => [{ kind: 'turn-end', reason: 'done' }]);
    manager.fleetDiff = async () => { throw new Error('git is not installed'); };

    await manager.requestFleetDiff();

    const msg = emitted().filter((m) => m.t === 'fleet-diff').pop();
    assert.strictEqual(msg?.t === 'fleet-diff' && msg.trees.length, 0);
    assert.strictEqual(
      msg?.t === 'fleet-diff' && (msg.reason ?? '').includes('git is not installed'),
      true,
    );
  });
});
