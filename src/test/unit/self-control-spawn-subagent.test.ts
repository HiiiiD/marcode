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

async function call(
  config: SelfControlMcpConfig, sid: string | undefined, name: string, args: Record<string, unknown>,
): Promise<{ isError?: boolean; content: { type: string; text: string }[] }> {
  const res = await fetch(sid ? `${config.url}?sid=${sid}` : config.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json() as { result: { isError?: boolean; content: { type: string; text: string }[] } }).result;
}

suite('marcode__spawn_subagent', () => {
  let dir: string;
  let manager: SessionManager;
  let server: SelfControlMcpServer;
  let config: SelfControlMcpConfig;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-spawnsub-'));
    const provider = new FakeProvider(() => [{ kind: 'text', delta: 'the answer' }, { kind: 'turn-end', reason: 'done' }]);
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

  test('a call returns a handle at once, leaves no roster row, and await returns the reply', async () => {
    const parent = await manager.create('fake', dir);
    const before = manager.summaries().length;
    const res = await call(config, parent.state.id, 'marcode__spawn_subagent', { prompt: 'do it' });
    assert.strictEqual(res.isError, undefined);
    const handle = JSON.parse(res.content[0].text) as { sessionId: string; status: string };
    assert.strictEqual(handle.status, 'running');
    assert.strictEqual(manager.summaries().length, before);
    assert.strictEqual(manager.summaries({ includeSubagents: true }).some((s) => s.name === handle.sessionId), true);
    const got = await call(config, parent.state.id, 'marcode__await_subagent', { sessionId: handle.sessionId });
    const body = JSON.parse(got.content[0].text) as { ok: boolean; text: string };
    assert.deepStrictEqual({ ok: body.ok, text: body.text }, { ok: true, text: 'the answer' });
  });

  test('a call with no identifiable caller is an error and creates nothing', async () => {
    const res = await call(config, undefined, 'marcode__spawn_subagent', { prompt: 'do it' });
    assert.strictEqual(res.isError, true);
    assert.strictEqual(manager.summaries({ includeSubagents: true }).length, 0);
  });

  test('an unknown provider is an error', async () => {
    const parent = await manager.create('fake', dir);
    const res = await call(config, parent.state.id, 'marcode__spawn_subagent', { prompt: 'x', provider: 'nope' });
    assert.strictEqual(res.isError, true);
  });

  test('a failing child reports ok:false with its reason when awaited', async () => {
    const provider = new FakeProvider(() => [{ kind: 'turn-end', reason: 'error', error: 'kaput' }]);
    const other = new SessionManager(new TranscriptStore(dir), new Map<string, AgentProvider>([['fake', provider]]), () => {});
    await other.init();
    const srv = new SelfControlMcpServer(other);
    const cfg = await srv.start();
    try {
      const parent = await other.create('fake', dir);
      const started = await call(cfg, parent.state.id, 'marcode__spawn_subagent', { prompt: 'x' });
      const { sessionId } = JSON.parse(started.content[0].text) as { sessionId: string };
      const got = await call(cfg, parent.state.id, 'marcode__await_subagent', { sessionId });
      const body = JSON.parse(got.content[0].text) as { ok: boolean; text: string };
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.text.includes('kaput'), true);
    } finally {
      await srv.dispose();
      await other.dispose();
    }
  });
});
