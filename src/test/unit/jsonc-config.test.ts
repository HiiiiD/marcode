import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { projectKeysFor, readJsonMembers, removeJsonMember, setJsonMember } from '../../shared/jsonc-config';

suite('jsonc-config', () => {
  let dir: string;
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-jsonc-')); });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('creates an absent file with only the new member', async () => {
    const file = path.join(dir, 'sub', '.mcp.json');
    await setJsonMember(file, ['mcpServers', 'a'], { command: 'x' });
    assert.deepStrictEqual(JSON.parse(await fs.readFile(file, 'utf8')), { mcpServers: { a: { command: 'x' } } });
  });

  test('preserves comments, other servers and unrelated keys', async () => {
    const file = path.join(dir, 'opencode.json');
    const before = '{\n  // note\n  "theme": 1,\n  "mcp": {\n    "other": { "type": "local", "command": ["o"] }\n  }\n}\n';
    await fs.writeFile(file, before);
    await setJsonMember(file, ['mcp', 'a'], { type: 'remote', url: 'https://a' });
    const after = await fs.readFile(file, 'utf8');
    assert.strictEqual(after.includes('// note'), true);
    assert.strictEqual(after.includes('"theme": 1'), true);
    assert.strictEqual(after.includes('"other": { "type": "local", "command": ["o"] }'), true);
    assert.deepStrictEqual(await readJsonMembers(file, ['mcp']), ['other', 'a']);
  });

  test('refuses malformed JSON and leaves the file untouched', async () => {
    const file = path.join(dir, '.mcp.json');
    await fs.writeFile(file, '{ "mcpServers": { ');
    await assert.rejects(setJsonMember(file, ['mcpServers', 'a'], {}), /isn't valid JSON/);
    assert.strictEqual(await fs.readFile(file, 'utf8'), '{ "mcpServers": { ');
  });

  test('remove deletes the member and reports whether it was there', async () => {
    const file = path.join(dir, '.mcp.json');
    await fs.writeFile(file, '{ "mcpServers": { "a": {}, "b": {} } }');
    assert.strictEqual(await removeJsonMember(file, ['mcpServers', 'a']), true);
    assert.strictEqual(await removeJsonMember(file, ['mcpServers', 'zzz']), false);
    assert.deepStrictEqual(await readJsonMembers(file, ['mcpServers']), ['b']);
  });

  test('remove on an absent file is false and creates nothing', async () => {
    const file = path.join(dir, 'none.json');
    assert.strictEqual(await removeJsonMember(file, ['mcpServers', 'a']), false);
    await assert.rejects(fs.stat(file));
  });

  test('readJsonMembers of an absent file is empty', async () => {
    assert.deepStrictEqual(await readJsonMembers(path.join(dir, 'none.json'), ['mcp']), []);
  });

  test('projectKeysFor matches E:/x and e:/x on win32', async function () {
    if (process.platform !== 'win32') { this.skip(); }
    const file = path.join(dir, '.claude.json');
    await fs.writeFile(file, JSON.stringify({ projects: { 'E:/Efebia/x': {}, 'e:/Efebia/x': {}, 'E:/Efebia/y': {} } }));
    assert.deepStrictEqual(await projectKeysFor(file, 'e:\\Efebia\\x'), ['E:/Efebia/x', 'e:/Efebia/x']);
  });
});
