import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MessageRouter } from '../../host/message-router';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { HostToWebview, ToolCall } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentEvent, AgentProvider } from '../../providers/types';

const BASH: ToolCall = { kind: 'command', label: 'Bash', command: 'ls' };
const spec = (cwd: string) => ({
  providerId: 'fake', model: undefined, effort: undefined, mode: undefined, cwd, includeEditorContext: undefined,
});
const tick = async (n = 10) => { for (let i = 0; i < n; i++) { await new Promise((r) => setTimeout(r, 5)); } };

suite('subagent promote', () => {
  let dir: string;
  let manager: SessionManager;
  let provider: FakeProvider;
  let scripts: Record<string, AgentEvent[]>;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-subpromote-'));
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

  const childOf = () => manager.summaries({ includeSubagents: true }).find((s) => s.kind === 'subagent')!;

  test('promoting a finished child makes it a roster session that keeps its parent', async () => {
    const parent = await manager.create('fake', dir);
    await manager.subagents.run(parent.state.id, spec(dir), 'job');
    const child = childOf();
    await manager.promoteSubagent(child.id);
    const promoted = manager.summaries().find((s) => s.id === child.id)!;
    assert.strictEqual(promoted.kind, undefined);
    assert.strictEqual(promoted.parentId, parent.state.id);
    assert.strictEqual(manager.visibleIds().includes(child.id), true);
  });

  test('promoting a running child detaches it: the card settles, the child lives on with its own approval', async () => {
    scripts.job = [{ kind: 'permission', id: 'p1', tool: BASH }];
    const parent = await manager.create('fake', dir);
    const started = await manager.subagents.runBackground(parent.state.id, spec(dir), 'job');
    assert.ok(started.ok);
    await tick();
    const child = childOf();
    await manager.promoteSubagent(child.id);
    await tick();
    assert.strictEqual(manager.subagents.running(parent.state.id), 0);
    assert.notStrictEqual(parent.state.status, 'awaiting-approval');
    const live = manager.get(child.id)!;
    assert.strictEqual(live !== undefined, true);
    assert.strictEqual((await live.snapshot()).pending.length, 1);
    assert.strictEqual(provider.sent.some((s) => s.text.includes('finished')), false);
  });

  test('promoting an unknown or ordinary session is a no-op', async () => {
    const plain = await manager.create('fake', dir);
    await manager.promoteSubagent('s-nope');
    await manager.promoteSubagent(plain.state.id);
    assert.strictEqual(manager.summaries().some((s) => s.id === plain.state.id), true);
  });

  test('the promote-subagent message reaches the manager', async () => {
    const sent: HostToWebview[] = [];
    const router = new MessageRouter(manager, (m) => sent.push(m), dir);
    const parent = await manager.create('fake', dir);
    await manager.subagents.run(parent.state.id, spec(dir), 'job');
    const child = childOf();
    await router.handle({ t: 'promote-subagent', id: child.id });
    assert.strictEqual(manager.summaries().some((s) => s.id === child.id), true);
  });
});
