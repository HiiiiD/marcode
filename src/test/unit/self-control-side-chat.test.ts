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

async function call(config: SelfControlMcpConfig, sid: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${config.url}?sid=${sid}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json() as { result: { isError?: boolean; content: { text: string }[] } }).result;
}

suite('self-control tools called from a side chat', () => {
  let dir: string;
  let manager: SessionManager;
  let server: SelfControlMcpServer;
  let config: SelfControlMcpConfig;
  let sideId: string;
  let parentId: string;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-sc-side-'));
    const provider = new FakeProvider(() => [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }]);
    manager = new SessionManager(new TranscriptStore(dir), new Map<string, AgentProvider>([['fake', provider]]), () => {});
    await manager.init();
    server = new SelfControlMcpServer(manager);
    config = await server.start();
    const parent = await manager.create('fake', dir);
    parent.send('plan it');
    for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
    await manager.setVisible([parent.state.id]);
    parentId = parent.state.id;
    sideId = (await manager.startSideChat(parentId))!.state.id;
  });

  teardown(async () => {
    await server.dispose();
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const refused = (r: { isError?: boolean; content: { text: string }[] }) =>
    r.isError === true && r.content[0].text.includes('Side chats are read-only');

  test('it cannot start sessions', async () => {
    assert.strictEqual(refused(await call(config, sideId, 'marcode__spawn_session', { cwd: dir, prompt: 'x', mode: 'default' })), true);
    assert.strictEqual(refused(await call(config, sideId, 'marcode__spawn_collaborators', { cwd: dir, workers: [{ task: 'x' }] })), true);
  });

  test('it cannot message another session or hand off', async () => {
    const parentName = manager.summaries().find((s) => s.id === parentId)!.name;
    assert.strictEqual(refused(await call(config, sideId, 'marcode__send_message', { to: parentName, text: 'hi' })), true);
    assert.strictEqual(refused(await call(config, sideId, 'marcode__handoff', {})), true);
  });

  test('read-only tools still work from a side chat', async () => {
    const res = await call(config, sideId, 'marcode__list_sessions', {});
    assert.notStrictEqual(res.isError, true);
  });

  test('an ordinary session is unaffected', async () => {
    const res = await call(config, parentId, 'marcode__spawn_session', { cwd: dir, prompt: 'x', mode: 'default' });
    assert.strictEqual(res.content[0].text.includes('Side chats are read-only'), false);
  });
});
