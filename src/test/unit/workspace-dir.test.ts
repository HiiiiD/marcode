import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeWorkspacePath, slugOf } from '../../shared/workspace-dir';
import { marcodeHome, resolveWorkspaceDir } from '../../host/workspace-dir';

suite('workspace-dir (pure)', () => {
  test('a windows path is case-folded, forward-slashed and slugged', () => {
    const n = normalizeWorkspacePath('E:\\Efebia\\hiiiid-code\\', 'win32');
    assert.strictEqual(n, 'e:/efebia/hiiiid-code');
    assert.strictEqual(slugOf(n), 'e--efebia-hiiiid-code');
  });

  test('two spellings of one windows folder share a slug', () => {
    assert.strictEqual(
      slugOf(normalizeWorkspacePath('E:/EFEBIA/x/', 'win32')),
      slugOf(normalizeWorkspacePath('e:\\efebia\\x', 'win32')),
    );
  });

  test('posix keeps case, so /Home/A and /home/a stay distinct', () => {
    assert.notStrictEqual(
      normalizeWorkspacePath('/Home/A', 'linux'),
      normalizeWorkspacePath('/home/a', 'linux'),
    );
  });

  test('drive roots and / still produce a non-empty slug', () => {
    assert.strictEqual(slugOf(normalizeWorkspacePath('E:\\', 'win32')), 'e-');
    assert.strictEqual(slugOf(normalizeWorkspacePath('/', 'linux')), '-');
  });

  test('a path over 80 chars is cut and hashed, deterministically', () => {
    const long = `/${'a'.repeat(120)}`;
    const slug = slugOf(long);
    assert.strictEqual(slug.length <= 80, true);
    assert.strictEqual(slug, slugOf(long));
    assert.notStrictEqual(slug, slugOf(`${long}b`));
  });

  test('unicode folder names are slugged to dashes, not dropped', () => {
    assert.strictEqual(slugOf('/home/ünï/proj'), '-home--n--proj');
  });
});

suite('workspace-dir (fs)', () => {
  let home: string;
  setup(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-home-')); });
  teardown(async () => { await fs.rm(home, { recursive: true, force: true }); });

  test('marcodeHome honours MARCODE_HOME', () => {
    assert.strictEqual(marcodeHome({ MARCODE_HOME: '/x/y' }), '/x/y');
    assert.strictEqual(marcodeHome({}).endsWith('.marcode'), true);
  });

  test('resolving twice yields the same directory and a workspace.json', async () => {
    const ws = path.join(home, 'proj');
    await fs.mkdir(ws);
    const a = await resolveWorkspaceDir(home, ws);
    const b = await resolveWorkspaceDir(home, ws);
    assert.strictEqual(a, b);
    const marker = JSON.parse(await fs.readFile(path.join(a, 'workspace.json'), 'utf8')) as { path: string };
    assert.strictEqual(marker.path, normalizeWorkspacePath(await fs.realpath(ws)));
  });

  test('two folders with the same slug get distinct directories', async () => {
    const a = await resolveWorkspaceDir(home, path.join(home, 'a', 'b-c'));
    const b = await resolveWorkspaceDir(home, path.join(home, 'a-b', 'c'));
    assert.notStrictEqual(a, b);
    assert.strictEqual(path.basename(b).endsWith('-2'), true);
  });

  test('no workspace uses _global', async () => {
    const dir = await resolveWorkspaceDir(home, undefined);
    assert.strictEqual(path.basename(dir), '_global');
  });

  test('two racing resolvers of one folder agree', async () => {
    const ws = path.join(home, 'race');
    const [a, b] = await Promise.all([resolveWorkspaceDir(home, ws), resolveWorkspaceDir(home, ws)]);
    assert.strictEqual(a, b);
  });

  test('a symlinked workspace resolves to the same directory as its target', async function () {
    const target = path.join(home, 'real');
    await fs.mkdir(target);
    const link = path.join(home, 'link');
    try { await fs.symlink(target, link, 'junction'); } catch { this.skip(); }
    assert.strictEqual(await resolveWorkspaceDir(home, link), await resolveWorkspaceDir(home, target));
  });
});
