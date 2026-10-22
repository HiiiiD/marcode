import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'node:stream';
import { addTomlServer, removeTomlServer } from '../../shared/toml-mcp';
import { CodexMcpConfig } from '../../providers/codex/mcp-config';
import { codexMcpControl } from '../../providers/codex/mcp-control';
import { AppServer } from '../../providers/codex/app-server';
import { CodexRun } from '../../providers/codex/codex-run';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

suite('toml-mcp', () => {
  let dir: string;
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-toml-')); });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('adds a table block to an absent file', async () => {
    const file = path.join(dir, '.codex', 'config.toml');
    await addTomlServer(file, 'blender', { command: 'C:\\uv.exe', args: ['run', 'b'], env: { K: 'v' }, cwd: 'E:\\x' });
    assert.strictEqual(await fs.readFile(file, 'utf8'),
      '[mcp_servers.blender]\ncommand = "C:\\\\uv.exe"\nargs = ["run", "b"]\ncwd = "E:\\\\x"\nenv = { K = "v" }\n');
  });

  test('keeps comments and other tables when adding', async () => {
    const file = path.join(dir, 'config.toml');
    await fs.writeFile(file, '# keep me\nmodel = "x"\n\n[mcp_servers.other]\nurl = "https://o"\n');
    await addTomlServer(file, 'h', { url: 'https://h/mcp', http_headers: { A: 'b' } });
    const text = await fs.readFile(file, 'utf8');
    assert.strictEqual(text.startsWith('# keep me\nmodel = "x"\n\n[mcp_servers.other]\nurl = "https://o"\n'), true);
    assert.strictEqual(text.endsWith('\n[mcp_servers.h]\nurl = "https://h/mcp"\nhttp_headers = { A = "b" }\n'), true);
  });

  test('refuses a name that already exists', async () => {
    const file = path.join(dir, 'config.toml');
    await fs.writeFile(file, '[mcp_servers."h"]\nurl = "x"\n');
    await assert.rejects(addTomlServer(file, 'h', { url: 'https://h' }), /already/);
  });

  test('refuses a file that defines servers inline', async () => {
    const file = path.join(dir, 'config.toml');
    await fs.writeFile(file, 'mcp_servers = { a = { url = "x" } }\n');
    await assert.rejects(addTomlServer(file, 'h', { url: 'https://h' }), /can't edit/i);
  });

  test('removes the table and its subtables, leaving the rest', async () => {
    const file = path.join(dir, 'config.toml');
    await fs.writeFile(file, '# top\n[mcp_servers.a]\ncommand = "x"\n\n[mcp_servers.a.env]\nK = "v"\n\n[mcp_servers.b]\nurl = "y"\n');
    assert.strictEqual(await removeTomlServer(file, 'a'), true);
    assert.strictEqual(await fs.readFile(file, 'utf8'), '# top\n[mcp_servers.b]\nurl = "y"\n');
    assert.strictEqual(await removeTomlServer(file, 'zzz'), false);
  });
});

suite('CodexMcpConfig', () => {
  let dir: string;
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-codex-mcp-')); });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  function store(answers: Record<string, unknown> = {}) {
    const calls: { method: string; params: any }[] = [];
    const s = new CodexMcpConfig({
      env: { CODEX_HOME: path.join(dir, 'home') },
      request: async <T>(method: string, params: unknown) => {
        calls.push({ method, params });
        return (answers[method] ?? {}) as T;
      },
    });
    return { s, calls };
  }
  const at = () => ({ cwd: path.join(dir, 'repo'), repoRoot: path.join(dir, 'repo') });

  test('global add sends config/batchWrite to the user file and reloads', async () => {
    const { s, calls } = store({ 'config/batchWrite': { filePath: 'C:\\home\\config.toml' } });
    const file = await s.add(at(), 'global', { name: 'h', transport: 'http', url: 'https://h', headers: { A: 'b' } });
    assert.strictEqual(file, 'C:\\home\\config.toml');
    assert.deepStrictEqual(calls.filter((c) => c.method === 'config/batchWrite'), [{ method: 'config/batchWrite', params: {
      edits: [{ keyPath: 'mcp_servers.h', value: { url: 'https://h', http_headers: { A: 'b' } }, mergeStrategy: 'replace' }],
      reloadUserConfig: true,
    } }]);
  });

  test('global add refuses a name already in the user config', async () => {
    const { s, calls } = store({ 'config/read': { layers: [{ name: { type: 'user' }, config: { mcp_servers: { h: {} } } }] } });
    await assert.rejects(s.add(at(), 'global', { name: 'h', transport: 'http', url: 'https://h', headers: {} }), /already/);
    assert.strictEqual(calls.some((c) => c.method === 'config/batchWrite'), false);
  });

  test('global remove writes null', async () => {
    const { s, calls } = store();
    await s.remove(at(), 'global', 'h');
    assert.deepStrictEqual(calls[0].params.edits, [{ keyPath: 'mcp_servers.h', value: null, mergeStrategy: 'replace' }]);
  });

  test('repo add writes the repo config.toml itself, with cwd', async () => {
    const { s, calls } = store();
    const file = await s.add(at(), 'repo', { name: 'b', transport: 'stdio', command: 'srv', args: [], env: {}, cwd: 'E:\\x' });
    assert.strictEqual(file, path.join(dir, 'repo', '.codex', 'config.toml'));
    assert.strictEqual(calls.length, 0);
    assert.strictEqual((await fs.readFile(file, 'utf8')).includes('cwd = "E:\\\\x"'), true);
  });

  test('targets carry the untrusted-project note', async () => {
    const { s } = store({ 'config/read': { layers: [
      { name: { type: 'project', dotCodexFolder: 'x' }, config: {}, disabledReason: 'add it as a trusted project' },
    ] } });
    const t = await s.targets(at());
    assert.deepStrictEqual(t.repo, { path: path.join(dir, 'repo', '.codex', 'config.toml'), note: 'Codex ignores this file for now: add it as a trusted project' });
    assert.deepStrictEqual(t.global, { path: path.join(dir, 'home', 'config.toml') });
  });

  test('capabilities: reconnect restarts, sign-in yes, no sse, working directory yes', () => {
    assert.deepStrictEqual(store().s.capabilities, { reconnect: 'restart', signIn: true, sse: false, workingDirectory: true });
  });
});

suite('codexMcpControl', () => {
  function control(answers: Record<string, unknown>, startup: Record<string, 'connected' | 'pending'> = {}) {
    const calls: { method: string; params: any }[] = [];
    const c = codexMcpControl({
      cwd: '/repo',
      threadId: () => 'th1',
      startupState: (name) => startup[name],
      request: async <T>(method: string, params: unknown) => { calls.push({ method, params }); return (answers[method] ?? {}) as T; },
    });
    return { c, calls };
  }

  test('status merges list, layers and startup state', async () => {
    const { c, calls } = control({
      'mcpServerStatus/list': { data: [
        { name: 'r', runtimeStatus: 'ready', tools: { a: {}, b: {} }, authStatus: 'unsupported' },
        { name: 'g', runtimeStatus: 'failed', toolsError: 'boom', tools: {}, authStatus: 'unsupported' },
        { name: 'l', tools: {}, authStatus: 'notLoggedIn' },
        { name: 'marcode_self_control', runtimeStatus: 'ready', tools: {}, authStatus: 'bearerToken' },
      ], nextCursor: null },
      'config/read': { layers: [
        { name: { type: 'project' }, config: { mcp_servers: { r: {} } } },
        { name: { type: 'user' }, config: { mcp_servers: { g: {}, l: {} } } },
      ] },
    });
    assert.deepStrictEqual(await c.status(), [
      { name: 'r', state: 'connected', toolCount: 2, origin: 'repo', canSignIn: false },
      { name: 'g', state: 'failed', error: 'boom', toolCount: 0, origin: 'global', canSignIn: false },
      { name: 'l', state: 'needs-auth', toolCount: 0, origin: 'global', canSignIn: true },
    ]);
    assert.deepStrictEqual(calls.map((x) => [x.method, x.params.threadId ?? x.params.cwd]), [
      ['mcpServerStatus/list', 'th1'], ['config/read', '/repo'],
    ]);
  });

  test('a server without runtimeStatus falls back to the startup notifications', async () => {
    const { c } = control({ 'mcpServerStatus/list': { data: [{ name: 's', tools: {}, authStatus: 'unsupported' }], nextCursor: null } }, { s: 'connected' });
    assert.strictEqual((await c.status())[0].state, 'connected');
  });

  test('signIn returns the authorization url', async () => {
    const { c, calls } = control({ 'mcpServer/oauth/login': { authorizationUrl: 'https://auth/x' } });
    assert.strictEqual(await c.signIn!('l'), 'https://auth/x');
    assert.deepStrictEqual(calls[0].params, { name: 'l', threadId: 'th1' });
  });
});

suite('CodexRun MCP', () => {
  test('configLoadedAt is undefined before the thread starts and set after', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new AppServer({ stdin, stdout, kill: () => {} });
    const run = new CodexRun(server, { cwd: '/repo', permissionMode: 'default', sessionId: 's' });
    assert.strictEqual(run.configLoadedAt(), undefined);
    run.send('hi');
    await tick();
    server.ingest(`${JSON.stringify({ id: 1, result: { thread: { id: 'th1' } } })}\n`);
    await tick();
    assert.strictEqual(typeof run.configLoadedAt(), 'number');
    assert.strictEqual(typeof run.mcp.status, 'function');
  });
});
