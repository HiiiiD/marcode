import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { toOpenCodeStatuses } from '../../providers/opencode/map-mcp-status';
import { OpenCodeMcpConfig } from '../../providers/opencode/mcp-config';

suite('OpenCode MCP status mapping', () => {
  test('maps states, needs_client_registration to needs-auth, and origins', () => {
    const out = toOpenCodeStatuses({
      a: { status: 'connected' },
      b: { status: 'failed', error: 'Operation timed out' },
      c: { status: 'needs_client_registration' },
      d: { status: 'needs_auth' },
      e: { status: 'disabled' },
      marcode_self_control: { status: 'connected' },
    }, new Map([['a', 'repo'], ['b', 'global'], ['c', 'global']]));
    assert.deepStrictEqual(out, [
      { name: 'a', state: 'connected', origin: 'repo', canSignIn: false },
      { name: 'b', state: 'failed', error: 'Operation timed out', origin: 'global', canSignIn: false },
      { name: 'c', state: 'needs-auth', origin: 'global', canSignIn: true },
      { name: 'd', state: 'needs-auth', canSignIn: true },
      { name: 'e', state: 'disabled', canSignIn: false },
    ]);
  });
});

suite('OpenCodeMcpConfig', () => {
  let dir: string;
  let repo: string;
  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-oc-mcp-'));
    repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
  });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const at = () => ({ cwd: repo, repoRoot: repo });
  const configDir = async () => path.join(dir, 'xdg', 'opencode');

  test('global target follows OPENCODE_CONFIG, then OPENCODE_CONFIG_DIR, then the server default', async () => {
    const file = path.join(dir, 'custom.json');
    assert.deepStrictEqual((await new OpenCodeMcpConfig({ env: { OPENCODE_CONFIG: file }, configDir }).targets(at())).global, { path: file });
    assert.deepStrictEqual((await new OpenCodeMcpConfig({ env: { OPENCODE_CONFIG_DIR: path.join(dir, 'd') }, configDir }).targets(at())).global,
      { path: path.join(dir, 'd', 'opencode.json') });
    assert.deepStrictEqual((await new OpenCodeMcpConfig({ env: {}, configDir }).targets(at())).global,
      { path: path.join(dir, 'xdg', 'opencode', 'opencode.json') });
  });

  test('OPENCODE_CONFIG_CONTENT makes global unavailable', async () => {
    const t = await new OpenCodeMcpConfig({ env: { OPENCODE_CONFIG_CONTENT: '{}' }, configDir }).targets(at());
    assert.strictEqual('unavailable' in t.global, true);
  });

  test('an existing opencode.jsonc is the repo target', async () => {
    await fs.writeFile(path.join(repo, 'opencode.jsonc'), '{}');
    const t = await new OpenCodeMcpConfig({ env: {}, configDir }).targets(at());
    assert.deepStrictEqual(t.repo, { path: path.join(repo, 'opencode.jsonc') });
  });

  test('stdio spec is written as local with a command array, comments kept', async () => {
    const file = path.join(repo, 'opencode.json');
    await fs.writeFile(file, '{\n  // mine\n  "theme": "x"\n}\n');
    await new OpenCodeMcpConfig({ env: {}, configDir }).add(at(), 'repo',
      { name: 'b', transport: 'stdio', command: 'uv', args: ['run', 'b'], env: { K: 'v' }, cwd: 'E:\\x' });
    const text = await fs.readFile(file, 'utf8');
    assert.strictEqual(text.includes('// mine'), true);
    assert.strictEqual(text.includes('"command": [\n        "uv",\n        "run",\n        "b"\n      ]'), true);
    assert.strictEqual(text.includes('"type": "local"'), true);
    assert.strictEqual(text.includes('"environment"'), true);
  });

  test('http spec is written as remote', async () => {
    const file = await new OpenCodeMcpConfig({ env: {}, configDir }).add(at(), 'global', { name: 'r', transport: 'http', url: 'https://r', headers: {} });
    assert.deepStrictEqual(JSON.parse(await fs.readFile(file, 'utf8')), { mcp: { r: { type: 'remote', url: 'https://r', headers: {} } } });
  });

  test('origins: repo wins over global for the same name', async () => {
    const store = new OpenCodeMcpConfig({ env: {}, configDir });
    await store.add(at(), 'global', { name: 'same', transport: 'http', url: 'https://g', headers: {} });
    await store.add(at(), 'global', { name: 'onlyg', transport: 'http', url: 'https://g', headers: {} });
    await store.add(at(), 'repo', { name: 'same', transport: 'http', url: 'https://r', headers: {} });
    assert.deepStrictEqual([...(await store.origins(at())).entries()].sort(), [['onlyg', 'global'], ['same', 'repo']]);
  });

  test('remove of a missing server says so', async () => {
    await assert.rejects(new OpenCodeMcpConfig({ env: {}, configDir }).remove(at(), 'repo', 'nope'), /isn't in/);
  });
});
