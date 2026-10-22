import * as assert from 'assert';
import { splitCommandLine } from '../../client-core/mcp/split-command';
import { parseMcpSnippet } from '../../client-core/mcp/parse-snippet';
import { validateSpec } from '../../client-core/mcp/validate-spec';
import { mcpRows, mcpSummary } from '../../client-core/mcp/mcp-rows';
import type { McpPanel } from '../../protocol/messages';

const caps = { reconnect: 'per-server' as const, signIn: false, sse: true, workingDirectory: false };
const panel = (over: Partial<McpPanel> = {}): McpPanel => ({ capabilities: caps, targets: null, pending: [], restarting: false, ...over });

suite('client-core mcp', () => {
  test('splits a quoted Windows path and keeps backslashes', () => {
    assert.deepStrictEqual(splitCommandLine('"C:\\Program Files\\x\\srv.exe" --flag "a b"'),
      { command: 'C:\\Program Files\\x\\srv.exe', args: ['--flag', 'a b'] });
  });

  test('splits a uv --directory line', () => {
    assert.deepStrictEqual(splitCommandLine('uv --directory E:\\Efebia\\blender_mcp\\mcp run blender-mcp'),
      { command: 'uv', args: ['--directory', 'E:\\Efebia\\blender_mcp\\mcp', 'run', 'blender-mcp'] });
  });

  test('single quotes group too', () => {
    assert.deepStrictEqual(splitCommandLine("node -e 'console.log(1)'"), { command: 'node', args: ['-e', 'console.log(1)'] });
  });

  test('unbalanced quote is an error', () => {
    assert.strictEqual('error' in splitCommandLine('npx "oops'), true);
  });

  test('empty line is an error', () => {
    assert.strictEqual('error' in splitCommandLine('   '), true);
  });

  test('snippet under mcpServers with one server fills name', () => {
    const r = parseMcpSnippet('{"mcpServers":{"shadcn":{"command":"npx","args":["shadcn@latest","mcp"]}}}');
    assert.deepStrictEqual(r, { server: { name: 'shadcn', transport: 'stdio', command: 'npx', args: ['shadcn@latest', 'mcp'], env: {} } });
  });

  test('snippet with several servers is rejected by name', () => {
    const r = parseMcpSnippet('{"mcpServers":{"a":{"command":"x"},"b":{"url":"https://b"},"c":{"command":"y"}}}');
    assert.deepStrictEqual(r, { error: 'Found 3 servers (a, b, c). Paste one at a time.' });
  });

  test('bare http object leaves name blank', () => {
    assert.deepStrictEqual(parseMcpSnippet('{"type":"http","url":"https://x/mcp","headers":{"A":"b"}}'),
      { server: { name: '', transport: 'http', url: 'https://x/mcp', headers: { A: 'b' } } });
  });

  test('sse type is kept', () => {
    assert.deepStrictEqual(parseMcpSnippet('{"s":{"type":"sse","url":"https://x/sse"}}'),
      { server: { name: 's', transport: 'sse', url: 'https://x/sse', headers: {} } });
  });

  test('opencode local/remote shapes are understood', () => {
    assert.deepStrictEqual(parseMcpSnippet('{"x":{"type":"local","command":["bun","srv.ts"],"environment":{"K":"v"}}}'),
      { server: { name: 'x', transport: 'stdio', command: 'bun', args: ['srv.ts'], env: { K: 'v' } } });
    assert.deepStrictEqual(parseMcpSnippet('{"r":{"type":"remote","url":"https://r/mcp"}}'),
      { server: { name: 'r', transport: 'http', url: 'https://r/mcp', headers: {} } });
  });

  test('stdio snippet keeps cwd', () => {
    assert.deepStrictEqual(parseMcpSnippet('{"b":{"command":"srv","cwd":"E:\\\\x"}}'),
      { server: { name: 'b', transport: 'stdio', command: 'srv', args: [], env: {}, cwd: 'E:\\x' } });
  });

  test('invalid JSON is an error', () => {
    assert.strictEqual('error' in parseMcpSnippet('{nope'), true);
  });

  test('object with no command or url is an error', () => {
    assert.strictEqual('error' in parseMcpSnippet('{"a":{"foo":1}}'), true);
  });

  test('name taken in target scope is invalid', () => {
    assert.strictEqual(typeof validateSpec({ name: 'a', transport: 'http', url: 'https://a', headers: {} }, ['a']), 'string');
  });

  test('blank name and non-http url are invalid', () => {
    assert.strictEqual(typeof validateSpec({ name: '', transport: 'stdio', command: 'x', args: [], env: {} }, []), 'string');
    assert.strictEqual(typeof validateSpec({ name: 'a', transport: 'http', url: 'ftp://a', headers: {} }, []), 'string');
  });

  test('a valid spec passes', () => {
    assert.strictEqual(validateSpec({ name: 'a-b_1', transport: 'stdio', command: 'x', args: [], env: {} }, ['other']), undefined);
  });

  test('rows order problems first and badge origins', () => {
    const rows = mcpRows([
      { name: 'ok', state: 'connected', toolCount: 3, origin: 'repo' },
      { name: 'bad', state: 'failed', error: 'boom', origin: 'global' },
      { name: 'blender', state: 'connected', origin: 'repo-private' },
      { name: 'corp', state: 'connected', origin: 'other', originLabel: 'managed' },
      { name: 'marcode_self_control', state: 'connected' },
    ], panel());
    assert.deepStrictEqual(rows.map((r) => [r.name, r.badge, r.detail, r.canRemove]), [
      ['bad', 'global', 'boom', true], ['blender', 'repo · private', '', true],
      ['corp', 'managed', '', false], ['ok', 'repo', '3 tools', true],
    ]);
  });

  test('needs-auth row offers sign-in only when the provider can', () => {
    const s = [{ name: 'l', state: 'needs-auth' as const, origin: 'global' as const, canSignIn: true }];
    assert.strictEqual(mcpRows(s, panel())[0].canSignIn, false);
    assert.strictEqual(mcpRows(s, panel({ capabilities: { ...caps, signIn: true } }))[0].canSignIn, true);
    assert.strictEqual(mcpRows(s, panel())[0].detail, 'needs sign-in');
  });

  test('pending add shows as a pending row', () => {
    const rows = mcpRows([], panel({ capabilities: null, pending: [{ name: 'n', origin: 'repo', change: 'added' }] }));
    assert.deepStrictEqual(rows.map((r) => [r.name, r.state, r.detail]), [['n', 'pending', 'added · restart to load']]);
  });

  test('pending remove keeps the row with an unload note', () => {
    const rows = mcpRows([{ name: 'n', state: 'connected', origin: 'repo' }], panel({ pending: [{ name: 'n', origin: 'repo', change: 'removed' }] }));
    assert.deepStrictEqual(rows.map((r) => [r.name, r.detail, r.canRemove]), [['n', 'removed · restart to unload', false]]);
  });

  test('read-only provider cannot remove or reconnect', () => {
    const rows = mcpRows([{ name: 'a', state: 'connected', origin: 'repo' }], panel({ capabilities: null }));
    assert.deepStrictEqual([rows[0].canRemove, rows[0].canReconnect], [false, false]);
  });

  test('while restarting every row reads pending, keeps its order and offers no action', () => {
    const servers = [
      { name: 'ok', state: 'connected' as const, toolCount: 3, origin: 'repo' as const },
      { name: 'bad', state: 'failed' as const, error: 'boom', origin: 'global' as const },
      { name: 'l', state: 'needs-auth' as const, origin: 'global' as const, canSignIn: true },
    ];
    const rows = mcpRows(servers, panel({ restarting: true, capabilities: { ...caps, signIn: true } }));
    assert.deepStrictEqual(rows.map((r) => [r.name, r.state, r.detail, r.canReconnect, r.canRemove, r.canSignIn, r.busy]), [
      ['bad', 'pending', 'restarting…', false, false, false, true],
      ['l', 'pending', 'restarting…', false, false, false, true],
      ['ok', 'pending', 'restarting…', false, false, false, true],
    ]);
  });

  test('VS Code servers wrapper is understood and its inputs ignored', () => {
    const r = parseMcpSnippet('{"inputs": [{"id": "key", "type": "promptString"}], "servers": {"gh": {"type": "http", "url": "https://gh/mcp"}}}');
    assert.deepStrictEqual(r, { server: { name: 'gh', transport: 'http', url: 'https://gh/mcp', headers: {} } });
  });

  test('JSONC with comments and trailing commas is accepted', () => {
    const r = parseMcpSnippet('{\n  // from the README\n  "mcpServers": {\n    "b": { "command": "uv", "args": ["run", "b",], },\n  },\n}');
    assert.deepStrictEqual(r, { server: { name: 'b', transport: 'stdio', command: 'uv', args: ['run', 'b'], env: {} } });
  });

  test('summary counts failing', () => {
    assert.strictEqual(mcpSummary(mcpRows([{ name: 'a', state: 'failed' }, { name: 'b', state: 'connected' }], undefined)), '2 servers · 1 failing');
    assert.strictEqual(mcpSummary(mcpRows([{ name: 'a', state: 'connected' }], undefined)), '1 server');
    assert.strictEqual(mcpSummary([]), 'No servers');
  });
});
