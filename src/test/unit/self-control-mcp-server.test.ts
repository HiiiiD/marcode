import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { SelfControlMcpServer, type SessionManagerLike } from '../../host/self-control-mcp-server';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { MemoryHit, MemoryStore } from '../../memory/types';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider, SelfControlMcpConfig } from '../../providers/types';

function fakeManager(overrides: Partial<SessionManagerLike> = {}): SessionManagerLike {
  return {
    catalog: () => [
      { id: 'claude', models: [{ id: 'sonnet' }], permissionModes: [{ id: 'default' }] },
    ],
    create: async () => ({ state: { id: 's-fake-1' } }),
    summaries: () => [],
    get: async () => undefined,
    ...overrides,
  };
}

async function callTool(
  config: SelfControlMcpConfig, name: string, args: Record<string, unknown>,
): Promise<{ isError?: boolean; content: { type: string; text: string }[] }> {
  const res = await fetch(config.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = await res.json() as { result: { isError?: boolean; content: { type: string; text: string }[] } };
  return body.result;
}

async function callToolAs(
  config: SelfControlMcpConfig, sid: string, name: string, args: Record<string, unknown>,
): Promise<{ isError?: boolean; content: { type: string; text: string }[] }> {
  const res = await fetch(`${config.url}?sid=${sid}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = await res.json() as { result: { isError?: boolean; content: { type: string; text: string }[] } };
  return body.result;
}

function fakeMemory(overrides: Partial<MemoryStore> = {}): MemoryStore {
  return {
    search: async () => [],
    fetch: async () => ({ sessionId: 's1', items: [] }),
    index: async () => {},
    forget: async () => {},
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

suite('SelfControlMcpServer memory tools', () => {
  test('marcode__recall returns snippets from MemoryStore.search()', async () => {
    const hit: MemoryHit = { sessionId: 's1', itemId: 'u1', snippet: 'Fixed the flaky login test', score: 1, ts: 1000 };
    const memory = fakeMemory({ search: async (query) => { assert.strictEqual(query, 'login'); return [hit]; } });
    const server = new SelfControlMcpServer(fakeManager(), memory);
    const config = await server.start();
    const result = await callTool(config, 'marcode__recall', { query: 'login' });
    assert.deepStrictEqual(JSON.parse(result.content[0].text), [hit]);
    await server.dispose();
  });

  test('marcode__recall_fetch returns MemoryStore.fetch()\'s slice', async () => {
    const memory = fakeMemory({
      fetch: async (hit) => {
        assert.strictEqual(hit.sessionId, 's1');
        assert.strictEqual(hit.itemId, 'u1');
        return { sessionId: 's1', items: [{ id: 'u1', ts: 0, role: 'user', text: 'hi' }] };
      },
    });
    const server = new SelfControlMcpServer(fakeManager(), memory);
    const config = await server.start();
    const result = await callTool(config, 'marcode__recall_fetch', { sessionId: 's1', itemId: 'u1' });
    const body = JSON.parse(result.content[0].text) as { items: unknown[] };
    assert.strictEqual(body.items.length, 1);
    await server.dispose();
  });

  test('marcode__recall errors without a MemoryStore configured', async () => {
    const server = new SelfControlMcpServer(fakeManager());
    const config = await server.start();
    const result = await callTool(config, 'marcode__recall', { query: 'login' });
    assert.strictEqual(result.isError, true);
    await server.dispose();
  });
});

suite('SelfControlMcpServer cross-session messaging', () => {
  test('marcode__list_sessions returns name/providerId/status/cwd for non-archived sessions', async () => {
    const manager = fakeManager({
      summaries: () => [
        { id: 's1', name: 'a', providerId: 'claude', status: 'idle', cwd: '/w1', archived: false } as never,
        { id: 's2', name: 'b', providerId: 'codex', status: 'running', cwd: '/w2', archived: true } as never,
      ],
    });
    const server = new SelfControlMcpServer(manager);
    const config = await server.start();
    const result = await callTool(config, 'marcode__list_sessions', {});
    const list = JSON.parse(result.content[0].text) as { name: string }[];
    assert.deepStrictEqual(list.map((s) => s.name), ['a']);
    await server.dispose();
  });

  test('send_message resolves the caller from sid, delivers to the named target', async () => {
    let interrupted = false;
    let sent: unknown[] = [];
    const target = { interrupt: async () => { interrupted = true; }, send: (...args: unknown[]) => { sent = args; } };
    const manager = fakeManager({
      summaries: () => [
        { id: 's-caller', name: 'a', providerId: 'claude', status: 'idle', cwd: '/w', archived: false } as never,
        { id: 's-target', name: 'b', providerId: 'codex', status: 'idle', cwd: '/w', archived: false } as never,
      ],
      get: async (id: string) => (id === 's-target' ? target as never : undefined),
    });
    const server = new SelfControlMcpServer(manager);
    const config = await server.start();
    const result = await callToolAs(config, 's-caller', 'marcode__send_message', { to: 'b', text: 'do the thing' });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(interrupted, true);
    assert.strictEqual(sent[0], 'do the thing');
    assert.deepStrictEqual(sent[4], { sessionId: 's-caller', name: 'a' });
    await server.dispose();
  });

  test('send_message resolves the target case-insensitively, matching rename()\'s own rule', async () => {
    let sent: unknown[] = [];
    const target = { interrupt: async () => {}, send: (...args: unknown[]) => { sent = args; } };
    const manager = fakeManager({
      summaries: () => [
        { id: 's-caller', name: 'a', providerId: 'claude', status: 'idle', cwd: '/w', archived: false } as never,
        { id: 's-target', name: 'Receiver', providerId: 'codex', status: 'idle', cwd: '/w', archived: false } as never,
      ],
      get: async (id: string) => (id === 's-target' ? target as never : undefined),
    });
    const server = new SelfControlMcpServer(manager);
    const config = await server.start();
    const result = await callToolAs(config, 's-caller', 'marcode__send_message', { to: 'RECEIVER', text: 'hi' });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(sent[0], 'hi');
    await server.dispose();
  });

  test('send_message errors when to equals the caller\'s own name case-insensitively', async () => {
    const manager = fakeManager({
      summaries: () => [{ id: 's-caller', name: 'Alice', providerId: 'claude', status: 'idle', cwd: '/w', archived: false } as never],
    });
    const server = new SelfControlMcpServer(manager);
    const config = await server.start();
    const result = await callToolAs(config, 's-caller', 'marcode__send_message', { to: 'alice', text: 'hi' });
    assert.strictEqual(result.isError, true);
    await server.dispose();
  });

  test('send_message errors on an unknown target name', async () => {
    const manager = fakeManager({
      summaries: () => [{ id: 's-caller', name: 'a', providerId: 'claude', status: 'idle', cwd: '/w', archived: false } as never],
    });
    const server = new SelfControlMcpServer(manager);
    const config = await server.start();
    const result = await callToolAs(config, 's-caller', 'marcode__send_message', { to: 'nobody', text: 'hi' });
    assert.strictEqual(result.isError, true);
    await server.dispose();
  });

  test('send_message errors when to equals the caller\'s own name', async () => {
    const manager = fakeManager({
      summaries: () => [{ id: 's-caller', name: 'a', providerId: 'claude', status: 'idle', cwd: '/w', archived: false } as never],
    });
    const server = new SelfControlMcpServer(manager);
    const config = await server.start();
    const result = await callToolAs(config, 's-caller', 'marcode__send_message', { to: 'a', text: 'hi' });
    assert.strictEqual(result.isError, true);
    await server.dispose();
  });

  test('send_message errors when sid is missing or unrecognized', async () => {
    const manager = fakeManager();
    const server = new SelfControlMcpServer(manager);
    const config = await server.start();
    const missing = await callTool(config, 'marcode__send_message', { to: 'b', text: 'hi' });
    assert.strictEqual(missing.isError, true);
    const unknown = await callToolAs(config, 's-ghost', 'marcode__send_message', { to: 'b', text: 'hi' });
    assert.strictEqual(unknown.isError, true);
    await server.dispose();
  });

  test('send_message reaches a session list_sessions advertises but no pane has opened this launch', async () => {
    // Important #3's regression: `manager.get()` alone only reaches a LIVE
    // session, but `summaries()` (and so `marcode__list_sessions`) spans
    // every non-archived session in `this.meta`, including one restored from
    // disk that no pane has opened yet. `get` here mirrors the real
    // `extension.ts` wiring: it goes through `manager.open()`, which
    // materializes a restored session on demand.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-self-control-reach-'));
    const store = new TranscriptStore(dir);
    const provider = new FakeProvider(() => [
      { kind: 'text', delta: 'ok' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const providers = new Map<string, AgentProvider>([['fake', provider]]);

    const first = new SessionManager(store, providers, () => {});
    await first.init();
    const receiver = await first.create('fake', process.cwd());
    first.rename(receiver.state.id, 'receiver');
    const sender = await first.create('fake', process.cwd());
    first.rename(sender.state.id, 'sender');
    // Shutdown without archiving either session — the same posture a window
    // reload takes: `archived` is left exactly as it was, so both come back
    // non-archived but with no live AgentSession until something opens one.
    await first.dispose();

    const second = new SessionManager(store, providers, () => {});
    await second.init();
    assert.strictEqual(second.get(receiver.state.id), undefined, 'restored session must not be live yet');
    assert.strictEqual(second.get(sender.state.id), undefined, 'restored session must not be live yet');

    try {
      const server = new SelfControlMcpServer({
        catalog: () => second.catalog(),
        create: (providerId, cwd, model, effort, mode) => second.create(providerId, cwd, model, effort, mode),
        summaries: () => second.summaries(),
        get: async (id) => {
          try { return await second.open(id); } catch { return undefined; }
        },
      });
      const config = await server.start();

      const listed = await callTool(config, 'marcode__list_sessions', {});
      const names = (JSON.parse(listed.content[0].text) as { name: string }[]).map((s) => s.name);
      assert.deepStrictEqual(names.sort(), ['receiver', 'sender']);

      const res = await fetch(`${config.url}?sid=${sender.state.id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream',
          authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'marcode__send_message', arguments: { to: 'receiver', text: 'still reachable' } },
        }),
      });
      const body = await res.json() as { result: { isError?: boolean; content: { type: string; text: string }[] } };
      assert.strictEqual(body.result.isError, undefined);

      const snapshot = await second.get(receiver.state.id)!.snapshot();
      assert.strictEqual(
        snapshot.items.some((i) => i.role === 'user' && i.text === 'still reachable'),
        true,
      );
      await server.dispose();
    } finally {
      await second.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('a real send_message call delivers into the target session\'s real transcript, tagged with from', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-self-control-msg-'));
    const store = new TranscriptStore(dir);
    const provider = new FakeProvider(() => [
      { kind: 'text', delta: 'ok' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const providers = new Map<string, AgentProvider>([['fake', provider]]);
    const manager = new SessionManager(store, providers, () => { });
    await manager.init();

    try {
      const a = await manager.create('fake', process.cwd());
      const b = await manager.create('fake', process.cwd());
      manager.rename(a.state.id, 'sender');
      manager.rename(b.state.id, 'receiver');

      const server = new SelfControlMcpServer(manager);
      const config = await server.start();
      const res = await fetch(`${config.url}?sid=${a.state.id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream',
          authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'marcode__send_message', arguments: { to: 'receiver', text: 'please do X' } },
        }),
      });
      const body = await res.json() as { result: { isError?: boolean } };
      assert.strictEqual(body.result.isError, undefined);

      const snapshot = await manager.get(b.state.id)!.snapshot();
      const item = snapshot.items.find((i) => i.role === 'user' && i.text === 'please do X');
      assert.strictEqual(item?.role === 'user' && item.from?.name, 'sender');
      await server.dispose();
    } finally {
      await manager.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
