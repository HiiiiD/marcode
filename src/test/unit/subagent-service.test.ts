import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { ToolCall } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentEvent, AgentProvider } from '../../providers/types';

const BASH: ToolCall = { kind: 'command', label: 'Bash', command: 'ls' };
const spec = (cwd: string) => ({
  providerId: 'fake', model: undefined, effort: undefined, mode: undefined, cwd, includeEditorContext: undefined,
});
const tick = async () => { for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); } };

suite('subagent service', () => {
  let dir: string;
  let manager: SessionManager;
  let provider: FakeProvider;
  let scripts: Record<string, AgentEvent[]>;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-subsvc-'));
    scripts = {};
    // The service prefixes a preamble, so scripts are keyed on the task text it ends with.
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

  test('a foreground run returns the child text, frees the live child and keeps its row hidden', async () => {
    scripts.task = [{ kind: 'text', delta: 'answer' }, { kind: 'turn-end', reason: 'done' }];
    const parent = await manager.create('fake', dir);
    const result = await manager.subagents.run(parent.state.id, spec(dir), 'task');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.text, 'answer');
    const child = manager.summaries({ includeSubagents: true }).find((s) => s.kind === 'subagent')!;
    assert.strictEqual(child.parentId, parent.state.id);
    assert.strictEqual(manager.get(child.id) === undefined, true);
    assert.strictEqual(manager.summaries().some((s) => s.id === child.id), false);
    assert.strictEqual(manager.subagents.running(parent.state.id), 0);
  });

  test('the child is told who delegated to it and that its reply is returned', async () => {
    const parent = await manager.create('fake', dir);
    await manager.subagents.run(parent.state.id, spec(dir), 'task');
    const sent = provider.sent[0].text;
    assert.strictEqual(sent.includes(parent.state.name), true);
    assert.strictEqual(sent.endsWith('task'), true);
  });

  test('an unknown parent fails cleanly without creating anything', async () => {
    const before = manager.summaries({ includeSubagents: true }).length;
    const result = await manager.subagents.run('s-nope', spec(dir), 'task');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(manager.summaries({ includeSubagents: true }).length, before);
  });

  test('running() counts a blocked child and cancelSubtree settles it, idempotently', async () => {
    scripts.task = [{ kind: 'permission', id: 'p1', tool: BASH }];
    const parent = await manager.create('fake', dir);
    const pending = manager.subagents.run(parent.state.id, spec(dir), 'task');
    await tick();
    assert.strictEqual(manager.subagents.running(parent.state.id), 1);
    manager.subagents.cancelSubtree(parent.state.id);
    manager.subagents.cancelSubtree(parent.state.id);
    const result = await pending;
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.text, 'Subagent cancelled');
    assert.strictEqual(manager.subagents.running(parent.state.id), 0);
  });

  test('interrupting the parent cancels its running subagents', async () => {
    scripts.task = [{ kind: 'permission', id: 'p1', tool: BASH }];
    const parent = await manager.create('fake', dir);
    const pending = manager.subagents.run(parent.state.id, spec(dir), 'task');
    await tick();
    await parent.interrupt();
    assert.strictEqual((await pending).ok, false);
  });

  test('closing the parent cancels its running subagents', async () => {
    scripts.task = [{ kind: 'permission', id: 'p1', tool: BASH }];
    const parent = await manager.create('fake', dir);
    const pending = manager.subagents.run(parent.state.id, spec(dir), 'task');
    await tick();
    await manager.close(parent.state.id);
    assert.strictEqual((await pending).ok, false);
  });
});
