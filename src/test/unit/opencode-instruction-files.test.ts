import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverInstructionFiles } from '../../providers/opencode/instruction-files';

suite('OpenCode instruction discovery', () => {
  let root: string;
  let home: string;
  let config: string;
  let repo: string;
  let cwd: string;
  setup(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-instructions-'));
    home = path.join(root, 'home');
    config = path.join(home, '.config', 'opencode');
    repo = path.join(root, 'repo');
    cwd = path.join(repo, 'src');
    await fs.mkdir(config, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
  });
  teardown(async () => { await fs.rm(root, { recursive: true, force: true }); });

  function sdk(instructions: string[] = []) {
    return {
      path: { get: async () => ({ data: { home, config, directory: cwd, worktree: repo } }) },
      config: { get: async () => ({ data: { instructions } }) },
    };
  }
  const write = (dir: string, name: string) => fs.writeFile(path.join(dir, name), 'Follow these instructions');

  test('uses the server config directory and all AGENTS ancestors within its worktree', async () => {
    await write(config, 'AGENTS.md');
    await write(repo, 'AGENTS.md');
    await write(cwd, 'AGENTS.md');
    await write(cwd, 'CLAUDE.md');
    await write(root, 'AGENTS.md');
    const result = await discoverInstructionFiles(sdk(), cwd, {});
    assert.deepEqual(result, {
      memoryFilesDiscovery: 'complete', memoryFiles: [config, cwd, repo].map((dir) => ({ path: path.join(dir, 'AGENTS.md'), source: 'discovered' })),
    });
  });

  test('honors Claude fallback and project-config disable flags', async () => {
    await fs.mkdir(path.join(home, '.claude'));
    await write(path.join(home, '.claude'), 'CLAUDE.md');
    await write(cwd, 'CLAUDE.md');
    const result = await discoverInstructionFiles(sdk(), cwd, {});
    assert.deepEqual(result.memoryFiles.map((f) => f.path), [path.join(home, '.claude', 'CLAUDE.md'), path.join(cwd, 'CLAUDE.md')]);
    assert.deepEqual((await discoverInstructionFiles(sdk(), cwd, {
      OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    })).memoryFiles, []);
    assert.deepEqual((await discoverInstructionFiles(sdk(), cwd, {
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    })).memoryFiles.map((f) => f.path), [path.join(home, '.claude', 'CLAUDE.md')]);
  });

  test('expands configured globs and home paths, deduplicates, and retains remote sources without claiming loading', async () => {
    await write(cwd, 'rules.md');
    await write(home, 'personal.md');
    const result = await discoverInstructionFiles(sdk(['*.md', '~/personal.md', '*.md', 'https://example.com/rules']), cwd, {});
    assert.deepEqual(result, {
      memoryFilesDiscovery: 'complete', memoryFiles: [path.join(cwd, 'rules.md'), path.join(home, 'personal.md'), 'https://example.com/rules']
        .map((path) => ({ path, source: 'discovered' })),
    });
  });

  test('discovery failures are unavailable rather than an empty loaded-file claim', async () => {
    const client = sdk();
    client.path.get = async () => { throw new Error('server unavailable'); };
    assert.deepEqual(await discoverInstructionFiles(client, cwd, {}), { memoryFilesDiscovery: 'unavailable', memoryFiles: [] });
  });

  test('an empty AGENTS file still suppresses the CLAUDE fallback', async () => {
    await fs.writeFile(path.join(config, 'AGENTS.md'), '');
    await fs.mkdir(path.join(home, '.claude'));
    await write(path.join(home, '.claude'), 'CLAUDE.md');
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), '');
    await write(cwd, 'CLAUDE.md');
    assert.deepEqual(await discoverInstructionFiles(sdk(), cwd, {}), { memoryFilesDiscovery: 'complete', memoryFiles: [] });
  });
});
