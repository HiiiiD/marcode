import * as assert from 'assert';
import { runSubagent } from './helpers/run-subagent';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { ToolCall, TranscriptItem } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentEvent, AgentProvider } from '../../providers/types';

const BASH: ToolCall = { kind: 'command', label: 'Bash', command: 'ls' };
const PLAN: ToolCall = { kind: 'plan', label: 'ExitPlanMode', text: 'the plan' };
const spec = (cwd: string) => ({
  providerId: 'fake', model: undefined, effort: undefined, mode: undefined, cwd, includeEditorContext: undefined,
});
const tick = async (n = 10) => { for (let i = 0; i < n; i++) { await new Promise((r) => setTimeout(r, 5)); } };

suite('subagent review fixes', () => {
  let dir: string;
  let manager: SessionManager;
  let scripts: Record<string, AgentEvent[]>;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-subfix-'));
    scripts = {};
    const provider = new FakeProvider((text) => {
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

  const cards = async (id: string) => (await manager.get(id)!.snapshot()).items.filter(
    (i): i is Extract<TranscriptItem, { role: 'tool' }> => i.role === 'tool' && i.tool.kind === 'subagent',
  );

  test('a background card stays running when the parent turn ends, and carries no background flag', async () => {
    scripts.job = [{ kind: 'permission', id: 'p1', tool: BASH }];
    const parent = await manager.create('fake', dir);
    await manager.subagents.runBackground(parent.state.id, spec(dir), 'job');
    await tick();
    parent.ingestNested({ kind: 'turn-end', reason: 'done' });
    await tick();
    const [card] = await cards(parent.state.id);
    assert.strictEqual(card.state, 'running');
    assert.strictEqual(card.tool.kind === 'subagent' && card.tool.background, undefined);
  });

  test('restarting the parent cancels its running subagents instead of orphaning them', async () => {
    scripts.job = [{ kind: 'permission', id: 'p1', tool: BASH }];
    const parent = await manager.create('fake', dir);
    const started = await manager.subagents.runBackground(parent.state.id, spec(dir), 'job');
    assert.ok(started.ok);
    await tick();
    await manager.restart(parent.state.id);
    const result = await manager.subagents.awaitResult(parent.state.id, started.sessionId, 500);
    assert.strictEqual(typeof result === 'object' && result.cancelled, true);
  });

  test('disposing the parent while a child waits on a question settles the foreground call', async () => {
    scripts.job = [{ kind: 'question', id: 'q1', questions: [], blocking: true }];
    const parent = await manager.create('fake', dir);
    const run = runSubagent(manager, parent.state.id, spec(dir), 'job');
    await tick();
    await parent.dispose();
    const result = await Promise.race([run, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 500))]);
    assert.notStrictEqual(result, 'hung');
  });

  test('releasing a child cancels the subagents it started', async () => {
    scripts.job = [{ kind: 'permission', id: 'p1', tool: BASH }];
    const root = await manager.create('fake', dir);
    const child = await manager.createSubagent(root.state.id, spec(dir));
    const started = await manager.subagents.runBackground(child.state.id, spec(dir), 'job');
    assert.ok(started.ok);
    await tick();
    const waiting = manager.subagents.awaitResult(child.state.id, started.sessionId, 500);
    await manager.releaseSubagent(child.state.id);
    const result = await waiting;
    assert.strictEqual(typeof result === 'object' && result.cancelled, true);
  });

  test("approving a child's plan does not take the parent out of plan mode", async () => {
    const parent = await manager.create('fake', dir, undefined, undefined, 'plan');
    parent.ingestNested({ kind: 'tool-start', id: 'card', tool: { kind: 'subagent', label: 'S', action: 'spawn' } });
    parent.ingestNested({ kind: 'permission', id: 'c:p1', tool: PLAN, parentId: 'card' }, { onDecision: () => {} });
    parent.respondToPermission('c:p1', { allow: true });
    assert.strictEqual(parent.state.permissionMode, 'plan');
  });
});
