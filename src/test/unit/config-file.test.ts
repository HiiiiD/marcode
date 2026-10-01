import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { favoriteModelsSource, loadConfig, patchConfig, seedConfigFile, seedConfigFileSafely, watchConfig } from '../../host/config-file';

suite('config-file', () => {
  let dir: string;
  let file: string;
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-cfg-')); file = path.join(dir, 'config.json'); });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('a missing file loads as the defaults without a warning', async () => {
    const { config, warnings } = await loadConfig(file);
    assert.deepStrictEqual(config.enabledProviders, ['claude', 'codex', 'opencode']);
    assert.deepStrictEqual(warnings, []);
  });

  test('an empty file is the defaults without a warning', async () => {
    await fs.writeFile(file, '');
    assert.deepStrictEqual((await loadConfig(file)).warnings, []);
  });

  test('patching a file that is not valid JSON refuses and leaves it byte-identical', async () => {
    const broken = '{ "enabledProviders": ["claude"], "review": { ';
    await fs.writeFile(file, broken);
    await assert.rejects(patchConfig(file, { favoriteModels: ['x'] }));
    assert.strictEqual(await fs.readFile(file, 'utf8'), broken);
  });

  test('a favorites toggle is what the next hydrate reads, and reaches the file', async () => {
    await fs.writeFile(file, JSON.stringify({ favoriteModels: ['a'] }));
    const warnings: string[] = [];
    const favorites = favoriteModelsSource(file, ['a'], (m) => warnings.push(m));
    await favorites.set(['a', 'b']);
    assert.deepStrictEqual(favorites.get(), ['a', 'b']);
    assert.deepStrictEqual((await loadConfig(file)).config.favoriteModels, ['a', 'b']);
    assert.deepStrictEqual(warnings, []);
  });

  test('a favorites write that cannot land warns instead of rejecting', async () => {
    await fs.writeFile(file, '{ not json');
    const warnings: string[] = [];
    const favorites = favoriteModelsSource(file, [], (m) => warnings.push(m));
    await favorites.set(['b']);
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(await fs.readFile(file, 'utf8'), '{ not json');
  });

  test('invalid JSON is the defaults plus one warning, never a throw', async () => {
    await fs.writeFile(file, '{ "enabledProviders": [');
    const { config, warnings } = await loadConfig(file);
    assert.strictEqual(warnings.length, 1);
    assert.deepStrictEqual(config.enabledProviders, ['claude', 'codex', 'opencode']);
  });

  test('seeding writes only explicit legacy values, and never overwrites', async () => {
    const wrote = await seedConfigFile(file, {
      enabledProviders: ['claude'], 'codex.path': '', 'opencode.path': '/o', 'memory.enabled': false, 'review.fileCap': 700,
    });
    assert.strictEqual(wrote, true);
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    assert.deepStrictEqual(raw, {
      enabledProviders: ['claude'], opencodePath: '/o', memory: { enabled: false }, review: { fileCap: 700 },
    });
    assert.strictEqual(await seedConfigFile(file, { enabledProviders: ['codex'] }), false);
    assert.deepStrictEqual((await loadConfig(file)).config.enabledProviders, ['claude']);
  });

  test('seeding under a home that cannot be written is a warning, never a throw', async () => {
    await fs.writeFile(path.join(dir, 'blocker'), '');
    const { warning } = await seedConfigFileSafely(path.join(dir, 'blocker', 'config.json'), { enabledProviders: ['claude'] });
    assert.strictEqual(typeof warning, 'string');
  });

  test('patchConfig merges into what is there and keeps unrelated keys', async () => {
    await fs.writeFile(file, JSON.stringify({ enabledProviders: ['claude'] }));
    await patchConfig(file, { favoriteModels: ['fake x'] });
    const { config } = await loadConfig(file);
    assert.deepStrictEqual(config.enabledProviders, ['claude']);
    assert.deepStrictEqual(config.favoriteModels, ['fake x']);
  });

  test('the watcher fires for a reload-relevant edit but not for favoriteModels', async () => {
    await fs.writeFile(file, JSON.stringify({ enabledProviders: ['claude'] }));
    const { config } = await loadConfig(file);
    let fired = 0;
    const w = watchConfig(file, config, () => { fired++; }, 10);
    await patchConfig(file, { favoriteModels: ['a'] });
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(fired, 0);
    await patchConfig(file, { enabledProviders: ['codex'] });
    for (let i = 0; i < 50 && fired === 0; i++) { await new Promise((r) => setTimeout(r, 10)); }
    await new Promise((r) => setTimeout(r, 40));
    w.dispose();
    assert.strictEqual(fired, 1);
  });
});
