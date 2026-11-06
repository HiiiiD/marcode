import * as assert from 'assert';
import { runSubagent } from './helpers/run-subagent';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { ToolCall } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentEvent, AgentProvider } from '../../providers/types';

const BASH: ToolCall = { kind: 'command', label: 'Bash', command: 'rm -rf build' };
const spec = (cwd: string) => ({
  providerId: 'fake', model: undefined, effort: undefined, mode: undefined, cwd, includeEditorContext: undefined,
});
const tick = async () => { for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); } };

suite('subagent approvals', () => {
  let dir: string;
  let manager: SessionManager;
  let provider: FakeProvider;
  let scripts: Record<string, AgentEvent[]>;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-subappr-'));
    scripts = {};
    provider = new FakeProvider((text) => {
      const key = Object.keys(scripts).find((k) => text.endsWith(k));
      return key ? scripts[key] : [{ kind: 'turn-end', reason: 'done' }];
    });
    manager = new SessionManager(new TranscriptStore(dir), new Map<string, AgentProvider>([['fake', provider]]), () => {});
    await manager.init();
  });

  teardown(async () => {
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const pendingIds = async (parent: { snapshot(): Promise<{ pending: { requestId: string }[] }> }) =>
    (await parent.snapshot()).pending.map((p) => p.requestId);

  test('a child approval surfaces on the parent, rolls up, and clears once answered', async () => {
    scripts.a = [{ kind: 'permission', id: 'p-a', tool: BASH }];
    const parent = await manager.create('fake', dir);
    const run = runSubagent(manager, parent.state.id, spec(dir), 'a');
    await tick();
    assert.strictEqual(parent.state.status, 'awaiting-approval');
    assert.strictEqual((parent.state.activityLabel ?? '').includes('Bash'), true);
    const live = manager.summaries().find((s) => s.id === parent.state.id)!;
    assert.deepStrictEqual(live.subagents, { running: 1, awaitingApproval: 1 });
    const [mirrored] = await pendingIds(parent);
    parent.respondToPermission(mirrored, { allow: true });
    await run;
    assert.strictEqual(manager.summaries().find((s) => s.id === parent.state.id)!.subagents, undefined);
  });

  test('two children are answered independently', async () => {
    scripts.a = [{ kind: 'permission', id: 'p-a', tool: BASH }];
    scripts.b = [{ kind: 'permission', id: 'p-b', tool: BASH }];
    const parent = await manager.create('fake', dir);
    const runA = runSubagent(manager, parent.state.id, spec(dir), 'a');
    const runB = runSubagent(manager, parent.state.id, spec(dir), 'b');
    await tick();
    const ids = await pendingIds(parent);
    assert.strictEqual(ids.length, 2);
    parent.respondToPermission(ids.find((i) => i.endsWith(':p-b'))!, { allow: true });
    await runB;
    assert.strictEqual(provider.decisions.has('p-b'), true);
    assert.strictEqual(provider.decisions.has('p-a'), false);
    assert.strictEqual(parent.state.status, 'awaiting-approval');
    parent.respondToPermission(ids.find((i) => i.endsWith(':p-a'))!, { allow: false, reason: 'no' });
    assert.strictEqual((await runA).ok, true);
    assert.deepStrictEqual(provider.decisions.get('p-a'), { allow: false, reason: 'no' });
  });

  test('a double answer is a no-op', async () => {
    scripts.a = [{ kind: 'permission', id: 'p-a', tool: BASH }];
    const parent = await manager.create('fake', dir);
    const run = runSubagent(manager, parent.state.id, spec(dir), 'a');
    await tick();
    const [mirrored] = await pendingIds(parent);
    parent.respondToPermission(mirrored, { allow: true });
    parent.respondToPermission(mirrored, { allow: false });
    await run;
    assert.deepStrictEqual(provider.decisions.get('p-a'), { allow: true });
  });

  test('interrupting the parent denies the pending request and clears waiting', async () => {
    scripts.a = [{ kind: 'permission', id: 'p-a', tool: BASH }];
    const parent = await manager.create('fake', dir);
    const run = runSubagent(manager, parent.state.id, spec(dir), 'a');
    await tick();
    await parent.interrupt();
    assert.strictEqual((await run).ok, false);
    assert.notStrictEqual(parent.state.status, 'awaiting-approval');
    assert.deepStrictEqual(await pendingIds(parent), []);
  });

  test('the roll-up is never written to the index', async () => {
    scripts.a = [{ kind: 'permission', id: 'p-a', tool: BASH }];
    const parent = await manager.create('fake', dir);
    const run = runSubagent(manager, parent.state.id, spec(dir), 'a');
    await tick();
    await manager.persistNow();
    assert.strictEqual((await fs.readFile(path.join(dir, 'index.json'), 'utf8')).includes('awaitingApproval'), false);
    manager.subagents.cancelSubtree(parent.state.id);
    await run;
  });
});
