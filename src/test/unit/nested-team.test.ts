import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, teardown, setup, test } from 'mocha';
import { SelfControlMcpServer } from '../../host/self-control-mcp-server';
import { buildWorkerPreamble } from '../../host/self-control/worker-preamble';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { ToolCall } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentEvent, AgentProvider, SelfControlMcpConfig } from '../../providers/types';

type Result = { isError?: boolean; content: { type: string; text: string }[] };

const BASH: ToolCall = { kind: 'command', label: 'Bash', command: 'ls' };
const tick = async (n = 15) => { for (let i = 0; i < n; i++) { await new Promise((r) => setTimeout(r, 5)); } };

suite('nested sessions and teams', () => {
  let dir: string;
  let manager: SessionManager;
  let provider: FakeProvider;
  let scripts: Record<string, AgentEvent[]>;
  let server: SelfControlMcpServer;
  let config: SelfControlMcpConfig;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-nested-team-'));
    scripts = {};
    provider = new FakeProvider((text) => {
      const key = Object.keys(scripts).find((k) => text.endsWith(k));
      return key ? scripts[key] : [{ kind: 'text', delta: 'done' }, { kind: 'turn-end', reason: 'done' }];
    });
    manager = new SessionManager(new TranscriptStore(dir), new Map<string, AgentProvider>([['fake', provider]]), () => {});
    await manager.init();
    server = new SelfControlMcpServer(manager);
    config = await server.start();
  });

  teardown(async () => {
    await server.dispose();
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const call = async (sid: string, name: string, args: Record<string, unknown>): Promise<Result> => {
    const res = await fetch(`${config.url}?sid=${sid}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await res.json() as { result: Result }).result;
  };

  const team = async (parentId: string, nested = true) => {
    const res = await call(parentId, 'marcode__spawn_collaborators', {
      nested, cwd: dir, workers: [{ task: 'task-a' }, { task: 'task-b' }],
    });
    assert.strictEqual(res.isError, undefined, res.content[0]?.text);
    return JSON.parse(res.content[0].text) as { workers: { sessionId: string; task: string }[] };
  };

  test('spawn_subagent no longer exists', async () => {
    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const names = ((await res.json() as { result: { tools: { name: string }[] } }).result.tools).map((t) => t.name);
    assert.strictEqual(names.includes('marcode__spawn_subagent'), false);
    assert.strictEqual(names.includes('marcode__await_subagent'), true);
  });

  test('a nested team is hidden, told about its siblings, and each reply wakes the lead', async () => {
    const parent = await manager.create('fake', dir);
    const before = manager.summaries().length;
    const { workers } = await team(parent.state.id);
    assert.deepStrictEqual(workers.map((w) => w.task), ['task-a', 'task-b']);
    assert.strictEqual(manager.summaries().length, before);
    await tick(30);
    const a = provider.sent.find((s) => s.text.includes('task-a'))!;
    assert.strictEqual(a.text.includes(workers[1].sessionId), true);
    assert.strictEqual(a.text.includes(parent.state.name), true);
    assert.strictEqual(provider.sent.filter((s) => s.text.includes('finished')).length, 2);
  });

  test('a non-nested team still gets a pane per worker', async () => {
    const parent = await manager.create('fake', dir);
    const before = manager.summaries().length;
    await team(parent.state.id, false);
    assert.strictEqual(manager.summaries().length, before + 2);
  });

  test('nested spawn_session returns a handle and leaves no roster row', async () => {
    const parent = await manager.create('fake', dir);
    const before = manager.summaries().length;
    const res = await call(parent.state.id, 'marcode__spawn_session', { nested: true, cwd: dir, prompt: 'solo' });
    assert.strictEqual(res.isError, undefined);
    assert.strictEqual(JSON.parse(res.content[0].text).status, 'running');
    assert.strictEqual(manager.summaries().length, before);
  });

  test('siblings can message each other; the message reaches the sibling as a delegated request', async () => {
    scripts['task-a'] = [{ kind: 'permission', id: 'pa', tool: BASH }];
    scripts['task-b'] = [{ kind: 'permission', id: 'pb', tool: BASH }];
    const parent = await manager.create('fake', dir);
    const { workers } = await team(parent.state.id);
    await tick();
    const [a, b] = workers.map((w) => manager.summaries({ includeSubagents: true }).find((s) => s.name === w.sessionId)!);
    const res = await call(a.id, 'marcode__send_message', { to: b.name, text: 'which port?' });
    assert.strictEqual(res.isError, undefined, res.content[0]?.text);
    const queued = manager.get(b.id)!.state.queued ?? [];
    assert.strictEqual(queued.some((q) => q.text === 'which port?' && q.from?.sessionId === a.id), true);
  });

  test('a nested child lists its siblings and parent', async () => {
    scripts['task-a'] = [{ kind: 'permission', id: 'pa', tool: BASH }];
    scripts['task-b'] = [{ kind: 'permission', id: 'pb', tool: BASH }];
    const parent = await manager.create('fake', dir);
    await manager.setVisible([parent.state.id]);
    const { workers } = await team(parent.state.id);
    await tick();
    const a = manager.summaries({ includeSubagents: true }).find((s) => s.name === workers[0].sessionId)!;
    const listed = JSON.parse((await call(a.id, 'marcode__list_sessions', {})).content[0].text) as
      { name: string; self?: boolean; sibling?: boolean; parent?: boolean }[];
    assert.strictEqual(listed.find((s) => s.self)?.name, a.name);
    assert.strictEqual(listed.find((s) => s.sibling)?.name, workers[1].sessionId);
    assert.strictEqual(listed.find((s) => s.parent)?.name, parent.state.name);
  });

  test('the lead can message a running child, but a stranger cannot reach it', async () => {
    scripts['task-a'] = [{ kind: 'permission', id: 'pa', tool: BASH }];
    scripts['task-b'] = [{ kind: 'permission', id: 'pb', tool: BASH }];
    const lead = await manager.create('fake', dir);
    const stranger = await manager.create('fake', dir);
    await manager.setVisible([lead.state.id, stranger.state.id]);
    const { workers } = await team(lead.state.id);
    await tick();
    const ok = await call(lead.state.id, 'marcode__send_message', { to: workers[0].sessionId, text: 'steer' });
    assert.strictEqual(ok.isError, undefined);
    const denied = await call(stranger.state.id, 'marcode__send_message', { to: workers[0].sessionId, text: 'hi' });
    assert.strictEqual(denied.isError, true);
  });

  test('a message to a sibling that already finished is refused cleanly', async () => {
    scripts['task-b'] = [{ kind: 'permission', id: 'pb', tool: BASH }];
    const parent = await manager.create('fake', dir);
    const { workers } = await team(parent.state.id);
    await tick(30);
    const b = manager.summaries({ includeSubagents: true }).find((s) => s.name === workers[1].sessionId)!;
    const res = await call(b.id, 'marcode__send_message', { to: workers[0].sessionId, text: 'late' });
    assert.strictEqual(res.isError, true);
    assert.strictEqual(res.content[0].text.includes('not available'), true);
  });

  test('the nested worker preamble says the reply comes back automatically and leaves the task to the prompt', () => {
    const text = buildWorkerPreamble({
      lead: 'lead', self: { name: 'w1', task: 'do it' }, siblings: [{ name: 'w2', task: 'other' }], commit: false, nested: true,
    });
    assert.strictEqual(text.includes('returned to "lead" automatically'), true);
    assert.strictEqual(text.includes('Your task:'), false);
    assert.strictEqual(text.includes('w2'), true);
  });
});
