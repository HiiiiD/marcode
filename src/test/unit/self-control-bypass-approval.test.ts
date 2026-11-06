import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, teardown, setup, test } from 'mocha';
import { SelfControlMcpServer } from '../../host/self-control-mcp-server';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider, SelfControlMcpConfig } from '../../providers/types';

type Result = { isError?: boolean; content: { type: string; text: string }[] };

function call(config: SelfControlMcpConfig, sid: string, name: string, args: Record<string, unknown>): Promise<Result> {
  return fetch(`${config.url}?sid=${sid}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }).then(async (res) => (await res.json() as { result: Result }).result);
}

const tick = async () => { for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 5)); } };

suite('bypass spawn approval', () => {
  let dir: string;
  let manager: SessionManager;
  let server: SelfControlMcpServer;
  let config: SelfControlMcpConfig;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-bypass-'));
    const provider = new FakeProvider(() => [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }]);
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

  const answer = async (parentId: string, decision: { allow: true } | { allow: false; reason?: string }) => {
    const parent = manager.get(parentId)!;
    const [pending] = (await parent.snapshot()).pending;
    assert.strictEqual(pending.tool.kind, 'spawn');
    parent.respondToPermission(pending.requestId, decision);
  };

  test('an allowed bypass spawn_session creates a bypass child', async () => {
    const parent = await manager.create('fake', dir);
    const before = manager.summaries().length;
    const pending = call(config, parent.state.id, 'marcode__spawn_session', { mode: 'bypass', cwd: dir, prompt: 'go' });
    await tick();
    await answer(parent.state.id, { allow: true });
    const res = await pending;
    assert.strictEqual(res.isError, undefined);
    assert.strictEqual(manager.summaries().length, before + 1);
    assert.strictEqual(manager.summaries().some((s) => s.permissionMode === 'bypass'), true);
  });

  test('a denied bypass spawn_session is an error and creates nothing', async () => {
    const parent = await manager.create('fake', dir);
    const before = manager.summaries().length;
    const pending = call(config, parent.state.id, 'marcode__spawn_session', { mode: 'bypass', cwd: dir, prompt: 'go' });
    await tick();
    await answer(parent.state.id, { allow: false, reason: 'nope' });
    const res = await pending;
    assert.strictEqual(res.isError, true);
    assert.strictEqual(res.content[0].text.includes('nope'), true);
    assert.strictEqual(manager.summaries().length, before);
  });

  test('a bypass-mode parent is still asked', async () => {
    const parent = await manager.create('fake', dir, undefined, undefined, 'bypass');
    const pending = call(config, parent.state.id, 'marcode__spawn_session', { mode: 'bypass', cwd: dir, prompt: 'go' });
    await tick();
    assert.strictEqual(parent.state.status, 'awaiting-approval');
    await answer(parent.state.id, { allow: false });
    assert.strictEqual((await pending).isError, true);
  });

  test('an inherited bypass is dropped without asking', async () => {
    const parent = await manager.create('fake', dir, undefined, undefined, 'bypass');
    const res = await call(config, parent.state.id, 'marcode__spawn_session', { cwd: dir, prompt: 'go' });
    assert.strictEqual(res.isError, undefined);
    assert.notStrictEqual(parent.state.status, 'awaiting-approval');
  });

  test('spawn_subagent with explicit bypass asks first, then runs', async () => {
    const parent = await manager.create('fake', dir);
    const pending = call(config, parent.state.id, 'marcode__spawn_subagent', { mode: 'bypass', prompt: 'go' });
    await tick();
    await answer(parent.state.id, { allow: true });
    const res = await pending;
    assert.strictEqual(res.isError, undefined);
    assert.strictEqual(JSON.parse(res.content[0].text).status, 'running');
  });

  test('interrupting the parent while the card is pending denies the spawn', async () => {
    const parent = await manager.create('fake', dir);
    const before = manager.summaries({ includeSubagents: true }).length;
    const pending = call(config, parent.state.id, 'marcode__spawn_subagent', { mode: 'bypass', prompt: 'go' });
    await tick();
    await parent.interrupt();
    assert.strictEqual((await pending).isError, true);
    assert.strictEqual(manager.summaries({ includeSubagents: true }).length, before);
  });
});
