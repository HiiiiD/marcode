import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { toMcpStatuses } from '../../providers/claude/mcp-status';
import { ClaudeMcpConfig, type ExecCli } from '../../providers/claude/mcp-config';

suite('Claude MCP status mapping', () => {
  test('hides claudeai and self-control, maps origins, drops config', () => {
    const out = toMcpStatuses([
      { name: 'claude.ai Gmail', status: 'needs-auth', source: 'claudeai', scope: 'claudeai' },
      { name: 'marcode_self_control', status: 'connected', source: 'sdk' },
      { name: 'shadcn', status: 'connected', source: 'project', scope: 'project', tools: [{ name: 'a' }],
        config: { type: 'http', url: 'https://x', headers: { authorization: 'Bearer sk-secret-123' } } },
      { name: 'chrome', status: 'connected', source: 'user', scope: 'user' },
      { name: 'blender', status: 'failed', source: 'local', scope: 'local', error: 'boom' },
      { name: 'corp', status: 'connected', source: 'managed' },
      { name: 'old', status: 'pending', scope: 'claudeai' },
      { name: 'figma', status: 'failed', source: 'plugin', scope: 'dynamic' },
    ]);
    assert.deepStrictEqual(out, [
      { name: 'shadcn', state: 'connected', toolCount: 1, origin: 'repo', canSignIn: false },
      { name: 'chrome', state: 'connected', origin: 'global', canSignIn: false },
      { name: 'blender', state: 'failed', error: 'boom', origin: 'repo-private', canSignIn: false },
      { name: 'corp', state: 'connected', origin: 'other', originLabel: 'managed', canSignIn: false },
      { name: 'figma', state: 'failed', origin: 'other', originLabel: 'plugin', canSignIn: false },
    ]);
    assert.strictEqual(JSON.stringify(out).includes('Bearer'), false);
  });

  test('a server with no source keeps today\'s shape', () => {
    assert.deepStrictEqual(toMcpStatuses([{ name: 'a', status: 'weird' }]), [{ name: 'a', state: 'pending' }]);
  });
});

suite('ClaudeMcpConfig', () => {
  let dir: string;
  let repo: string;
  let home: string;
  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-claude-mcp-'));
    repo = path.join(dir, 'repo');
    home = path.join(dir, 'cfg');
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(home, { recursive: true });
  });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const at = () => ({ cwd: repo, repoRoot: repo });
  const spec = { name: 'blender', transport: 'stdio' as const, command: 'uv', args: ['run', 'b'], env: { K: 'v' } };

  test('targets honour CLAUDE_CONFIG_DIR', async () => {
    const store = new ClaudeMcpConfig({ env: { CLAUDE_CONFIG_DIR: home } });
    assert.deepStrictEqual(await store.targets(at()), {
      repo: { path: path.join(repo, '.mcp.json') }, global: { path: path.join(home, '.claude.json') },
    });
  });

  test('repo add writes .mcp.json under the repo root', async () => {
    const store = new ClaudeMcpConfig({ env: { CLAUDE_CONFIG_DIR: home } });
    const file = await store.add(at(), 'repo', spec);
    assert.strictEqual(file, path.join(repo, '.mcp.json'));
    assert.deepStrictEqual(JSON.parse(await fs.readFile(file, 'utf8')),
      { mcpServers: { blender: { type: 'stdio', command: 'uv', args: ['run', 'b'], env: { K: 'v' } } } });
  });

  test('global add goes through the CLI with -s user and the instance env', async () => {
    const calls: { args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
    const exec: ExecCli = async (_file, args, o) => { calls.push({ args, cwd: o.cwd, env: o.env }); return { stdout: '', stderr: '' }; };
    const store = new ClaudeMcpConfig({ env: { CLAUDE_CONFIG_DIR: home }, cliPath: () => 'claude.exe', exec });
    await store.add(at(), 'global', { name: 'h', transport: 'http', url: 'https://h/mcp', headers: {} });
    assert.deepStrictEqual(calls.map((c) => [c.args, c.cwd, c.env.CLAUDE_CONFIG_DIR]), [[
      ['mcp', 'add-json', 'h', '{"type":"http","url":"https://h/mcp","headers":{}}', '-s', 'user'], repo, home,
    ]]);
  });

  test('global add without a CLI falls back to a verified JSON edit', async () => {
    const store = new ClaudeMcpConfig({ env: { CLAUDE_CONFIG_DIR: home }, cliPath: () => undefined });
    await fs.writeFile(path.join(home, '.claude.json'), '{ "numStartups": 3 }');
    await store.add(at(), 'global', spec);
    const json = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8'));
    assert.deepStrictEqual([json.numStartups, Object.keys(json.mcpServers)], [3, ['blender']]);
  });

  test('a failing CLI surfaces its stderr', async () => {
    const exec: ExecCli = async () => { throw Object.assign(new Error('exit 1'), { stderr: 'MCP server h already exists in user config\n' }); };
    const store = new ClaudeMcpConfig({ env: { CLAUDE_CONFIG_DIR: home }, cliPath: () => 'claude.exe', exec });
    await assert.rejects(store.add(at(), 'global', spec), /already exists in user config/);
  });

  test('repo remove of a missing server says so', async () => {
    const store = new ClaudeMcpConfig({ env: { CLAUDE_CONFIG_DIR: home } });
    await assert.rejects(store.remove(at(), 'repo', 'nope'), /isn't in/);
  });

  test('private remove runs the CLI from the repo and cleans other spellings of the project key', async function () {
    if (process.platform !== 'win32') { this.skip(); }
    const file = path.join(home, '.claude.json');
    const upper = repo.replace(/\\/g, '/');
    const lower = upper[0].toLowerCase() + upper.slice(1);
    await fs.writeFile(file, JSON.stringify({ projects: {
      [upper]: { mcpServers: { blender: {} } }, [lower]: { mcpServers: { blender: {}, keep: {} } },
    } }, null, 2));
    const calls: { args: string[]; cwd: string }[] = [];
    const exec: ExecCli = async (_f, args, o) => { calls.push({ args, cwd: o.cwd }); return { stdout: '', stderr: '' }; };
    const store = new ClaudeMcpConfig({ env: { CLAUDE_CONFIG_DIR: home }, cliPath: () => 'claude.exe', exec });
    assert.strictEqual(await store.remove(at(), 'repo-private', 'blender'), file);
    assert.deepStrictEqual(calls, [{ args: ['mcp', 'remove', 'blender', '-s', 'local'], cwd: repo }]);
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepStrictEqual([Object.keys(json.projects[upper].mcpServers), Object.keys(json.projects[lower].mcpServers)], [[], ['keep']]);
  });
});
