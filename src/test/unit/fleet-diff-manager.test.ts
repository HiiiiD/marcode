// Attribution: which session wrote which file, from the transcript rather
// than from git — because git sees one dirty tree when three sessions share
// a root, and the panel is the only thing that knows more.

import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { HostToWebview } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';

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
