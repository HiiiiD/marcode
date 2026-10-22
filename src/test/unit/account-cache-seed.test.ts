import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AccountCache } from '../../host/account-cache/account-cache';
import { seedFromWorkspaces } from '../../host/account-cache/seed-from-workspaces';
import type { ModelInfo, UsageWindow } from '../../providers/types';

const win = (id: string): UsageWindow => ({ id, label: id, usedPercent: 10 }) as UsageWindow;
const model = (id: string): ModelInfo => ({ id, displayName: id }) as ModelInfo;

suite('seedFromWorkspaces', () => {
  let dir: string;
  let wsDir: string;
  const caches: AccountCache[] = [];
  const open = (): AccountCache => { const c = AccountCache.open(path.join(dir, 'account.sqlite')); caches.push(c); return c; };

  const put = async (slug: string, name: string, providers: unknown, mtimeSec?: number): Promise<string> => {
    const d = path.join(wsDir, slug);
    await fs.mkdir(d, { recursive: true });
    const f = path.join(d, name);
    await fs.writeFile(f, typeof providers === 'string' ? providers : JSON.stringify({ providers }));
    if (mtimeSec !== undefined) { await fs.utimes(f, mtimeSec, mtimeSec); }
    return f;
  };

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'account-seed-'));
    wsDir = path.join(dir, 'workspaces');
  });

  teardown(async () => {
    for (const c of caches.splice(0)) { c.close(); }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  test('newest file wins per instance', async () => {
    await put('a', 'usage.json', { claude: [win('old')], codex: [win('only-old')] }, 1000);
    await put('b', 'usage.json', { claude: [win('new')] }, 2000);
    const c = open();
    await seedFromWorkspaces(c, wsDir);
    const rows = Object.fromEntries(c.readUsage().map((r) => [r.instance, r.windows?.[0]?.id]));
    assert.deepStrictEqual(rows, { claude: 'new', codex: 'only-old' });
  });

  test('catalog seeded the same way', async () => {
    await put('a', 'catalog.json', { claude: [model('old')], codex: [model('only-old')] }, 1000);
    await put('b', 'catalog.json', { claude: [model('new')] }, 2000);
    const c = open();
    await seedFromWorkspaces(c, wsDir);
    const rows = Object.fromEntries(c.readCatalog().map((r) => [r.instance, r.models[0].id]));
    assert.deepStrictEqual(rows, { claude: 'new', codex: 'only-old' });
  });

  test('does nothing when the cache already has rows', async () => {
    await put('a', 'usage.json', { codex: [win('x')] }, 1000);
    const c = open();
    c.writeUsage({ instance: 'claude', windows: [win('keep')], fetchedAt: 5 });
    await seedFromWorkspaces(c, wsDir);
    assert.deepStrictEqual(c.readUsage().map((r) => r.instance), ['claude']);
  });

  test('malformed and missing files are skipped', async () => {
    await put('a', 'usage.json', '{not json');
    await put('b', 'catalog.json', JSON.stringify({ providers: 5 }));
    await put('c', 'usage.json', { claude: [win('ok')] }, 1000);
    await fs.mkdir(path.join(wsDir, 'empty'), { recursive: true });
    const c = open();
    await seedFromWorkspaces(c, wsDir);
    assert.deepStrictEqual(c.readUsage().map((r) => r.instance), ['claude']);
    assert.deepStrictEqual(c.readCatalog(), []);
  });

  test('missing workspaces dir resolves', async () => {
    const c = open();
    await seedFromWorkspaces(c, path.join(dir, 'nope'));
    assert.strictEqual(c.isEmpty(), true);
  });

  test('source files are untouched', async () => {
    const f = await put('a', 'usage.json', { claude: [win('w')] }, 1000);
    const g = await put('a', 'catalog.json', { claude: [model('m')] }, 1000);
    const before = await Promise.all([f, g].map(async (p) => [await fs.readFile(p, 'utf8'), (await fs.stat(p)).mtimeMs]));
    await seedFromWorkspaces(open(), wsDir);
    const after = await Promise.all([f, g].map(async (p) => [await fs.readFile(p, 'utf8'), (await fs.stat(p)).mtimeMs]));
    assert.deepStrictEqual(after, before);
  });
});
