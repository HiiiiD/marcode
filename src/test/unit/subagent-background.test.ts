import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SelfControlMcpServer } from '../../host/self-control-mcp-server';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { ToolCall } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentEvent, AgentProvider, SelfControlMcpConfig } from '../../providers/types';

const BASH: ToolCall = { kind: 'command', label: 'Bash', command: 'ls' };
const spec = (cwd: string) => ({
  providerId: 'fake', model: undefined, effort: undefined, mode: undefined, cwd, includeEditorContext: undefined,
});
const tick = async (n = 10) => { for (let i = 0; i < n; i++) { await new Promise((r) => setTimeout(r, 5)); } };

suite('subagent background', () => {
  let dir: string;
  let manager: SessionManager;
  let provider: FakeProvider;
  let scripts: Record<string, AgentEvent[]>;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-subbg-'));
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

  const pendingOf = async (id: string) => (await manager.get(id)!.snapshot()).pending;

  test('a background run returns a handle at once and delivers one message on completion', async () => {
    scripts.job = [{ kind: 'permission', id: 'p1', tool: BASH }];
    const parent = await manager.create('fake', dir);
    const started = await manager.subagents.runBackground(parent.state.id, spec(dir), 'job');
    assert.strictEqual(started.ok, true);
    await tick();
    assert.strictEqual(manager.subagents.running(parent.state.id), 1);
    manager.get(parent.state.id)!.respondToPermission((await pendingOf(parent.state.id))[0].requestId, { allow: true });
    await tick(20);
    const delivered = provider.sent.filter((s) => s.text.includes('finished'));
    assert.strictEqual(delivered.length, 1);
    assert.strictEqual(started.ok && delivered[0].text.includes(started.sessionId), true);
  });

  test('await returns the result, pending on timeout, and undefined for an unknown handle', async () => {
    scripts.job = [{ kind: 'permission', id: 'p1', tool: BASH }];
    const parent = await manager.create('fake', dir);
    const started = await manager.subagents.runBackground(parent.state.id, spec(dir), 'job');
    assert.ok(started.ok);
    assert.strictEqual(await manager.subagents.awaitResult(parent.state.id, started.sessionId, 30), 'pending');
    assert.strictEqual(await manager.subagents.awaitResult(parent.state.id, 'nope', 30), undefined);
    manager.get(parent.state.id)!.respondToPermission((await pendingOf(parent.state.id))[0].requestId, { allow: true });
    const result = await manager.subagents.awaitResult(parent.state.id, started.sessionId, 2000);
    assert.strictEqual(typeof result === 'object' && result.ok, true);
  });

  test('a background approval left unanswered is denied and the card says why', async () => {
    scripts.job = [{ kind: 'permission', id: 'p1', tool: BASH }];
    manager.subagents.approvalTimeoutMs = 40;
    const parent = await manager.create('fake', dir);
    const started = await manager.subagents.runBackground(parent.state.id, spec(dir), 'job');
    assert.ok(started.ok);
    await tick(20);
    assert.deepStrictEqual(provider.decisions.get('p1'), { allow: false, reason: 'Blocked: approval not granted' });
    assert.notStrictEqual(parent.state.status, 'awaiting-approval');
  });

  test('interrupting the parent cancels a background child and delivers nothing', async () => {
    scripts.job = [{ kind: 'permission', id: 'p1', tool: BASH }];
    const parent = await manager.create('fake', dir);
    await manager.subagents.runBackground(parent.state.id, spec(dir), 'job');
    await tick();
    await parent.interrupt();
    await tick(20);
    assert.strictEqual(manager.subagents.running(parent.state.id), 0);
    assert.strictEqual(provider.sent.some((s) => s.text.includes('finished')), false);
  });

  suite('over MCP', () => {
    let server: SelfControlMcpServer;
    let config: SelfControlMcpConfig;
    setup(async () => { server = new SelfControlMcpServer(manager); config = await server.start(); });
    teardown(async () => { await server.dispose(); });

    const call = async (sid: string, name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${config.url}?sid=${sid}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream',
          authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return (await res.json() as { result: { isError?: boolean; content: { text: string }[] } }).result;
    };

    test('background:true returns a handle and await_subagent collects the reply', async () => {
      scripts.job = [{ kind: 'text', delta: 'reply' }, { kind: 'turn-end', reason: 'done' }];
      const parent = await manager.create('fake', dir);
      const started = await call(parent.state.id, 'marcode__spawn_subagent', { prompt: 'job', background: true });
      const handle = JSON.parse(started.content[0].text) as { sessionId: string; background: boolean };
      assert.strictEqual(handle.background, true);
      const got = await call(parent.state.id, 'marcode__await_subagent', { sessionId: handle.sessionId });
      assert.strictEqual(JSON.parse(got.content[0].text).text, 'reply');
    });

    test('await_subagent on an unknown handle is an error', async () => {
      const parent = await manager.create('fake', dir);
      const got = await call(parent.state.id, 'marcode__await_subagent', { sessionId: 'nope' });
      assert.strictEqual(got.isError, true);
    });
  });
});
