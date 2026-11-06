import * as assert from 'assert';
import { runSubagent } from './helpers/run-subagent';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { approveSpawn } from '../../host/subagent/host-approval';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { SubagentService, type SubagentHost } from '../../host/subagent/subagent-service';
import type { HostToWebview, ToolCall } from '../../protocol/messages';
import { codexSelfControlConfig } from '../../providers/codex/self-control-config';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentEvent, AgentProvider } from '../../providers/types';
import { describeTool } from '../../webview/components/tool-render';

const BASH: ToolCall = { kind: 'command', label: 'Bash', command: 'ls' };
const spec = (cwd: string) => ({
  providerId: 'fake', model: undefined, effort: undefined, mode: undefined, cwd, includeEditorContext: undefined,
});
const tick = async (n = 10) => { for (let i = 0; i < n; i++) { await new Promise((r) => setTimeout(r, 5)); } };

suite('subagent minors', () => {
  let dir: string;
  let manager: SessionManager;
  let provider: FakeProvider;
  let scripts: Record<string, AgentEvent[]>;
  let sent: HostToWebview[];

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-subminor-'));
    scripts = {};
    sent = [];
    provider = new FakeProvider((text) => {
      const key = Object.keys(scripts).find((k) => text.endsWith(k));
      return key ? scripts[key] : [{ kind: 'turn-end', reason: 'done' }];
    });
    manager = new SessionManager(new TranscriptStore(dir), new Map<string, AgentProvider>([['fake', provider]]), (m) => sent.push(m));
    await manager.init();
  });

  teardown(async () => {
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  test('removing a parent cancels its subagents before deleting them, delivering nothing', async () => {
    scripts.job = [{ kind: 'permission', id: 'p1', tool: BASH }];
    const parent = await manager.create('fake', dir);
    await manager.subagents.runBackground(parent.state.id, spec(dir), 'job');
    await tick();
    await manager.remove(parent.state.id);
    await tick(20);
    assert.strictEqual(provider.sent.some((s) => s.text.includes('failed') || s.text.includes('finished')), false);
  });

  test('promoting an already-promoted child just shows it', async () => {
    const parent = await manager.create('fake', dir);
    await runSubagent(manager, parent.state.id, spec(dir), 'job');
    const child = manager.summaries({ includeSubagents: true }).find((s) => s.kind === 'subagent')!;
    await manager.promoteSubagent(child.id);
    await manager.close(child.id);
    assert.strictEqual(manager.visibleIds().includes(child.id), false);
    await manager.promoteSubagent(child.id);
    assert.strictEqual(manager.visibleIds().includes(child.id), true);
  });

  test('a release still in flight is observable until it finishes', async () => {
    let resolveRelease!: () => void;
    const gate = new Promise<void>((r) => { resolveRelease = r; });
    const parent = await manager.create('fake', dir);
    const childLive = await manager.createSubagent(parent.state.id, spec(dir));
    const host: SubagentHost = {
      get: () => parent,
      createSubagent: async () => childLive,
      releaseSubagent: async () => { await gate; },
      removeSubagent: async () => {},
      changed: () => {},
    };
    const service = new SubagentService(host);
    const started = await service.runBackground(parent.state.id, spec(dir), 'job');
    assert.ok(started.ok);
    await tick();
    assert.strictEqual(service.pendingRelease(childLive.state.id) !== undefined, true);
    resolveRelease();
    await service.awaitResult(parent.state.id, started.sessionId, 5000);
    assert.strictEqual(service.pendingRelease(childLive.state.id), undefined);
  });

  test('the preamble reaches the model but not the child transcript or title', async () => {
    const parent = await manager.create('fake', dir);
    await runSubagent(manager, parent.state.id, spec(dir), 'investigate the bug');
    const child = manager.summaries({ includeSubagents: true }).find((s) => s.kind === 'subagent')!;
    assert.strictEqual(child.title, 'investigate the bug');
    assert.strictEqual(provider.sent[0].text.includes('You are a subagent'), true);
    const opened = await manager.open(child.id);
    const users = (await opened.snapshot()).items.filter((i) => i.role === 'user');
    assert.deepStrictEqual(users.map((u) => u.role === 'user' && u.text), ['investigate the bug']);
  });

  test('a child that ends on a bookkeeping tool still returns its last words', async () => {
    scripts.job = [
      { kind: 'text', delta: 'the answer' },
      { kind: 'tool-start', id: 't1', tool: BASH },
      { kind: 'tool-end', id: 't1', ok: true, output: { kind: 'text', text: '' } },
      { kind: 'turn-end', reason: 'done' },
    ];
    const parent = await manager.create('fake', dir);
    const result = await runSubagent(manager, parent.state.id, spec(dir), 'job');
    assert.strictEqual(result.text, 'the answer');
  });

  test('a question from a child says which subagent is asking', async () => {
    scripts.job = [{
      kind: 'question', id: 'q1', blocking: true,
      questions: [{ id: 'a', header: 'Which?', question: 'Pick one', multiSelect: false, allowOther: false, secret: false }],
    }];
    const parent = await manager.create('fake', dir);
    const run = runSubagent(manager, parent.state.id, spec(dir), 'job');
    await tick();
    const [question] = (await parent.snapshot()).pendingQuestions;
    const child = manager.summaries({ includeSubagents: true }).find((s) => s.kind === 'subagent')!;
    assert.strictEqual(question.questions[0].header.startsWith(`${child.name}: `), true);
    manager.subagents.cancelSubtree(parent.state.id);
    await run;
  });

  test('relative edit paths from a child are claimed against the child cwd', async () => {
    const other = path.join(dir, 'other');
    await fs.mkdir(other);
    const edit: ToolCall = { kind: 'file-edit', label: 'Edit', files: [{ path: 'x.ts', op: 'modify' }] };
    scripts.job = [
      { kind: 'tool-start', id: 't1', tool: edit },
      { kind: 'tool-end', id: 't1', ok: true, output: { kind: 'none' } },
      { kind: 'turn-end', reason: 'done' },
    ];
    const parent = await manager.create('fake', dir);
    await runSubagent(manager, parent.state.id, spec(other), 'job');
    const claimed = [...parent.claimedPaths].map((p) => path.resolve(p));
    assert.strictEqual(claimed.includes(path.resolve(other, 'x.ts')), true);
    assert.strictEqual(claimed.includes(path.resolve(dir, 'x.ts')), false);
  });

  test('session-status is never emitted for a subagent', async () => {
    const parent = await manager.create('fake', dir);
    await runSubagent(manager, parent.state.id, spec(dir), 'job');
    const child = manager.summaries({ includeSubagents: true }).find((s) => s.kind === 'subagent')!;
    assert.strictEqual(sent.some((m) => m.t === 'session-status' && m.id === child.id), false);
  });

  test('the bypass card names a subagent as a subagent', async () => {
    const s = await manager.create('fake', dir);
    const outcome = approveSpawn(s, { ...spec(dir), mode: 'bypass' }, 'x', 'subagent');
    await tick();
    const [pending] = (await s.snapshot()).pending;
    assert.strictEqual(pending.tool.kind === 'spawn' && pending.tool.label, 'Spawn subagent');
    await s.interrupt();
    await outcome;
  });

  test('a background approval left unanswered reports it as blocked', async () => {
    scripts.job = [{ kind: 'permission', id: 'p1', tool: BASH }];
    manager.subagents.approvalTimeoutMs = 30;
    const parent = await manager.create('fake', dir);
    await manager.subagents.runBackground(parent.state.id, spec(dir), 'job');
    await tick(20);
    assert.deepStrictEqual(provider.decisions.get('p1'), { allow: false, reason: 'Blocked: approval not granted' });
  });

  test('only the newest background handles are kept', async () => {
    manager.subagents.maxHandles = 2;
    const parent = await manager.create('fake', dir);
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      const started = await manager.subagents.runBackground(parent.state.id, spec(dir), `job${i}`);
      assert.ok(started.ok);
      names.push(started.sessionId);
    }
    await tick(20);
    assert.strictEqual(await manager.subagents.awaitResult(parent.state.id, names[0], 10), undefined);
    assert.notStrictEqual(await manager.subagents.awaitResult(parent.state.id, names[2], 10), undefined);
  });

  test('the generic MCP card for spawn_subagent reads as a delegation, not a raw tool call', () => {
    const header = describeTool({ kind: 'mcp', label: 'spawn', server: 'marcode_self_control', tool: 'marcode__spawn_subagent' });
    assert.strictEqual(header.primary, 'Delegated to a subagent');
  });

  test('the Codex tool timeout for our server is raised past its 60s default', () => {
    const cfg = codexSelfControlConfig('http://127.0.0.1:1/mcp', 's-1');
    assert.strictEqual(cfg.mcp_servers.marcode_self_control.tool_timeout_sec >= 3600, true);
    assert.strictEqual(cfg.mcp_servers.marcode_self_control.url, 'http://127.0.0.1:1/mcp?sid=s-1');
    assert.strictEqual(cfg.mcp_servers.marcode_self_control.bearer_token_env_var, 'MARCODE_SELF_CONTROL_TOKEN');
  });
});
