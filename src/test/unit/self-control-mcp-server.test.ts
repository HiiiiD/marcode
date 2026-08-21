import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { SelfControlMcpServer, type SessionManagerLike } from '../../host/self-control-mcp-server';

function fakeManager(overrides: Partial<SessionManagerLike> = {}): SessionManagerLike {
  return {
    catalog: () => [
      { id: 'claude', models: [{ id: 'sonnet' }], permissionModes: [{ id: 'default' }] },
    ],
    create: async () => ({ state: { id: 's-fake-1' } }),
    ...overrides,
  };
}

suite('SelfControlMcpServer', () => {
  test('start() returns a loopback url and a token', async () => {
    const server = new SelfControlMcpServer(fakeManager());
    const config = await server.start();
    assert.strictEqual(config.url.startsWith('http://127.0.0.1:'), true);
    assert.strictEqual(typeof config.token === 'string' && config.token.length > 0, true);
    await server.dispose();
  });

  test('rejects an unknown provider without touching create()', async () => {
    let created = false;
    const server = new SelfControlMcpServer(fakeManager({
      create: async () => { created = true; return { state: { id: 'x' } }; },
    }));
    const config = await server.start();
    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'marcode__spawn_session', arguments: { provider: 'nope', cwd: '/tmp', prompt: 'hi' } },
      }),
    });
    const body = await res.json() as { result?: { isError?: boolean } };
    assert.strictEqual(body.result?.isError, true);
    assert.strictEqual(created, false);
    await server.dispose();
  });

  test('rejects a request with no/wrong bearer token', async () => {
    const server = new SelfControlMcpServer(fakeManager());
    const config = await server.start();
    const res = await fetch(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'marcode__spawn_session', arguments: { provider: 'claude', cwd: '/tmp', prompt: 'hi' } },
      }),
    });
    assert.strictEqual(res.status, 401);
    await server.dispose();
  });

  test('spawn_session calls create() with the requested provider/cwd/prompt and returns a sessionId', async () => {
    let seenArgs: unknown[] = [];
    const server = new SelfControlMcpServer(fakeManager({
      create: async (...args) => { seenArgs = args; return { state: { id: 's-new-1' } }; },
    }));
    const config = await server.start();
    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'marcode__spawn_session',
          arguments: { provider: 'claude', model: 'sonnet', mode: 'default', cwd: '/tmp/work', prompt: 'do the thing' },
        },
      }),
    });
    const body = await res.json() as { result: { content: { type: string; text: string }[] } };
    const parsed = JSON.parse(body.result.content[0].text) as { sessionId: string };
    assert.strictEqual(parsed.sessionId, 's-new-1');
    assert.deepStrictEqual(seenArgs.slice(0, 4), ['claude', '/tmp/work', 'sonnet', undefined]);
    await server.dispose();
  });
});
