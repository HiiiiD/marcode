import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { SelfControlMcpServer, type SessionManagerLike } from '../../host/self-control-mcp-server';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';

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

  test('a real tool call against a real SessionManager creates a session and delivers the prompt', async () => {
    // Same fixture pattern as session-manager.test.ts's suite-level setup(): a
    // fresh temp dir, a real TranscriptStore, and a FakeProvider scripted to
    // answer 'ok' — the one test in this file exercising the whole path
    // (SelfControlMcpServer -> real SessionManager -> real AgentSession ->
    // FakeProvider) rather than the narrow SessionManagerLike fake above.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-self-control-'));
    const store = new TranscriptStore(dir);
    const provider = new FakeProvider(() => [
      { kind: 'text', delta: 'ok' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const providers = new Map<string, AgentProvider>([['fake', provider]]);
    const manager = new SessionManager(store, providers, () => { });
    await manager.init();

    try {
      const server = new SelfControlMcpServer(manager);
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
            arguments: { provider: 'fake', cwd: process.cwd(), prompt: 'hello' },
          },
        }),
      });
      const body = await res.json() as { result: { content: { type: string; text: string }[] } };
      const { sessionId } = JSON.parse(body.result.content[0].text) as { sessionId: string };
      assert.strictEqual(manager.summaries().some((s) => s.id === sessionId), true);
      // Closes Important #3's assertion gap: the tool returning a sessionId
      // is not proof the prompt was delivered. Read the real session's own
      // transcript back and check the user message actually landed there.
      const spawned = manager.get(sessionId);
      assert.strictEqual(spawned !== undefined, true);
      const snapshot = await spawned!.snapshot();
      assert.strictEqual(
        snapshot.items.some((i) => i.role === 'user' && i.text === 'hello'),
        true,
      );
      await server.dispose();
    } finally {
      await manager.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects a relative cwd', async () => {
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
        params: {
          name: 'marcode__spawn_session',
          arguments: { provider: 'claude', cwd: 'relative/path', prompt: 'hi' },
        },
      }),
    });
    const body = await res.json() as { result?: { isError?: boolean; content?: { text: string }[] } };
    assert.strictEqual(body.result?.isError, true);
    assert.strictEqual(body.result?.content?.[0]?.text.includes('absolute'), true);
    assert.strictEqual(created, false);
    await server.dispose();
  });

  test('rejects mode: bypass even when the provider advertises it', async () => {
    let created = false;
    const server = new SelfControlMcpServer(fakeManager({
      catalog: () => [
        { id: 'claude', models: [{ id: 'sonnet' }], permissionModes: [{ id: 'default' }, { id: 'bypass' }] },
      ],
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
        params: {
          name: 'marcode__spawn_session',
          arguments: { provider: 'claude', mode: 'bypass', cwd: '/tmp/work', prompt: 'hi' },
        },
      }),
    });
    const body = await res.json() as { result?: { isError?: boolean; content?: { text: string }[] } };
    assert.strictEqual(body.result?.isError, true);
    assert.strictEqual(body.result?.content?.[0]?.text.includes('bypass'), true);
    assert.strictEqual(created, false);
    await server.dispose();
  });

  test('two concurrent tool calls that reuse JSON-RPC id 1 each get their own correct response', async () => {
    // Regression test for Critical #1: a single shared McpServer/transport
    // correlates requests to responses on the raw JSON-RPC id,
    // transport-globally. Two independent MCP clients naturally both start
    // at id 1, so without per-request transports the second POST's id->stream
    // mapping overwrites the first's, misdelivering responses.
    const server = new SelfControlMcpServer(fakeManager({
      create: async (providerId, cwd) => ({ state: { id: `s-${cwd}` } }),
    }));
    const config = await server.start();
    const callFor = (cwd: string) => fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'marcode__spawn_session',
          arguments: { provider: 'claude', cwd, prompt: 'hi' },
        },
      }),
    });

    const [resA, resB] = await Promise.all([callFor('/tmp/a'), callFor('/tmp/b')]);
    const bodyA = await resA.json() as { result: { content: { type: string; text: string }[] } };
    const bodyB = await resB.json() as { result: { content: { type: string; text: string }[] } };
    const parsedA = JSON.parse(bodyA.result.content[0].text) as { sessionId: string };
    const parsedB = JSON.parse(bodyB.result.content[0].text) as { sessionId: string };

    assert.strictEqual(parsedA.sessionId, 's-/tmp/a');
    assert.strictEqual(parsedB.sessionId, 's-/tmp/b');
    await server.dispose();
  });

  test('a post-bind server error does not crash the process (permanent error listener)', async () => {
    const server = new SelfControlMcpServer(fakeManager());
    const config = await server.start();
    const http = (server as unknown as { http: import('node:http').Server }).http;
    assert.strictEqual(http.listenerCount('error') > 0, true);
    // Emitting 'error' with zero listeners is what throws in Node; asserting
    // a listener is attached is the whole regression guard here without
    // reaching into private internals further than this file already does.
    await server.dispose();
  });
});
