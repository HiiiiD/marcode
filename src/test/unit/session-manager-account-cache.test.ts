import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AccountCache } from '../../host/account-cache/account-cache';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider, UsageWindow } from '../../providers/types';
import { modelProvider, unavailableProvider } from './helpers/model-providers';

const win = (id: string, usedPercent = 10): UsageWindow => ({ id, label: id, usedPercent });

suite('SessionManager with AccountCache', () => {
  let workspace: string;
  let cacheDir: string;
  let cacheFile: string;
  let caches: AccountCache[];
  let managers: SessionManager[];

  const openCache = (p = cacheFile): AccountCache => {
    const c = AccountCache.open(p);
    caches.push(c);
    return c;
  };

  async function managerWith(
    cache: AccountCache, providers: Map<string, AgentProvider>,
  ): Promise<SessionManager> {
    const m = new SessionManager(new TranscriptStore(workspace), providers, () => {});
    managers.push(m);
    m.setAccountCache(cache);
    await m.init();
    return m;
  }

  setup(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-sm-ws-'));
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-sm-cache-'));
    cacheFile = path.join(cacheDir, 'account.sqlite');
    caches = [];
    managers = [];
  });

  teardown(async () => {
    for (const m of managers) { await m.dispose(); }
    for (const c of caches) { c.close(); }
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  test('a fresh workspace seeds its catalog from the shared cache', async () => {
    const cache = openCache();
    cache.writeCatalog({ instance: 'claude', models: [{ id: 'opus', displayName: 'Opus 5' }], fetchedAt: 1 });

    const m = await managerWith(cache, new Map([['claude', unavailableProvider('claude', 'not yet')]]));

    assert.deepStrictEqual(m.catalog().map((p) => ({ id: p.id, models: p.models })), [
      { id: 'claude', models: [{ id: 'opus', displayName: 'Opus 5' }] },
    ]);
  });

  test('a successful probe writes the catalog row', async () => {
    const cache = openCache();
    cache.writeCatalog({ instance: 'claude', models: [{ id: 'opus', displayName: 'Opus 5' }], fetchedAt: 1 });
    const m = await managerWith(cache, new Map([['claude', modelProvider('claude')]]));

    await m.refreshModels('/repo');

    const rows = openCache().readCatalog();
    assert.deepStrictEqual(rows.map((r) => ({ instance: r.instance, models: r.models })), [
      { instance: 'claude', models: [{ id: 'fresh-/repo', displayName: 'Fresh' }] },
    ]);
    assert.strictEqual(rows[0].fetchedAt > 1, true);
  });

  test('a failed probe writes nothing', async () => {
    const cache = openCache();
    cache.writeCatalog({ instance: 'claude', models: [{ id: 'opus', displayName: 'Opus 5' }], fetchedAt: 1 });
    const m = await managerWith(cache, new Map<string, AgentProvider>([
      ['claude', unavailableProvider('claude', 'gone')],
      ['codex', unavailableProvider('codex', 'gone')],
    ]));

    await m.refreshModels('/repo');

    assert.deepStrictEqual(openCache().readCatalog(), [
      { instance: 'claude', models: [{ id: 'opus', displayName: 'Opus 5' }], fetchedAt: 1 },
    ]);
  });

  test('a pulled usage reading is written with windows', async () => {
    const cache = openCache();
    const p = new FakeProvider(() => [], { windows: [win('five-hour', 33)] });
    const m = await managerWith(cache, new Map<string, AgentProvider>([['fake', p]]));

    await m.refreshUsage('/repo');

    const rows = openCache().readUsage();
    assert.deepStrictEqual(rows.map((r) => ({ instance: r.instance, windows: r.windows })), [
      { instance: 'fake', windows: [win('five-hour', 33)] },
    ]);
  });

  test('a pulled mirror reading is written under the mirror id', async () => {
    const cache = openCache();
    const target = new FakeProvider(() => [], { windows: [win('five-hour', 44)] });
    const m = new SessionManager(
      new TranscriptStore(workspace),
      new Map<string, AgentProvider>([['source', new FakeProvider(() => [])], ['codex', target]]),
      () => {}, undefined, undefined, undefined, undefined, [], undefined, undefined,
      [{ sourceProviderId: 'source', modelPattern: '^openai/', targetProviderId: 'codex',
        usageProviderId: 'source-openai', displayName: 'OpenCode (OpenAI)' }],
    );
    managers.push(m);
    m.setAccountCache(cache);
    await m.init();

    await m.refreshUsage('/repo');

    const mirrored = openCache().readUsage().find((r) => r.instance === 'source-openai');
    assert.deepStrictEqual(mirrored?.windows, [win('five-hour', 44)]);
  });

  test('a pulled undefined writes a tombstone', async () => {
    const cache = openCache();
    cache.writeUsage({ instance: 'fake', windows: [win('five-hour')], fetchedAt: 1 });
    const p = new FakeProvider(() => [], { usageUnavailable: true });
    const m = await managerWith(cache, new Map<string, AgentProvider>([['fake', p]]));
    assert.deepStrictEqual(Object.keys(m.usageSnapshot()), ['fake']);

    await m.refreshUsage('/repo');

    const row = openCache().readUsage().find((r) => r.instance === 'fake');
    assert.strictEqual(row?.windows, null);
    assert.strictEqual(row.fetchedAt > 1, true);
  });

  test('a run-path undefined writes nothing', async () => {
    const cache = openCache();
    cache.writeUsage({ instance: 'fake', windows: [win('five-hour')], fetchedAt: 1 });
    const m = await managerWith(cache, new Map<string, AgentProvider>([['fake', new FakeProvider(() => [])]]));

    m.usageWindows('fake', undefined);

    assert.deepStrictEqual(m.usageSnapshot(), {});
    assert.deepStrictEqual(openCache().readUsage(), [
      { instance: 'fake', windows: [win('five-hour')], fetchedAt: 1 },
    ]);
  });

  test('init ignores usage rows for unconfigured instances', async () => {
    const cache = openCache();
    cache.writeUsage({ instance: 'ghost', windows: [win('five-hour')], fetchedAt: 1 });
    cache.writeUsage({ instance: 'fake', windows: [win('seven-day')], fetchedAt: 1 });
    const m = await managerWith(cache, new Map<string, AgentProvider>([['fake', new FakeProvider(() => [])]]));

    assert.deepStrictEqual(Object.keys(m.usageSnapshot()), ['fake']);
    assert.strictEqual(openCache().readUsage().some((r) => r.instance === 'ghost'), true);
  });

  test('init survives an unavailable cache', async () => {
    const cache = openCache(cacheDir);
    assert.strictEqual(cache.available, false);

    const m = new SessionManager(
      new TranscriptStore(workspace), new Map<string, AgentProvider>([['fake', new FakeProvider(() => [])]]), () => {},
    );
    managers.push(m);
    m.setAccountCache(cache);
    await assert.doesNotReject(() => m.init());
    assert.deepStrictEqual(m.usageSnapshot(), {});
  });

  test('persist no longer writes usage.json or catalog.json', async () => {
    const cache = openCache();
    const m = await managerWith(cache, new Map<string, AgentProvider>([['claude', modelProvider('claude')]]));
    m.usageWindows('claude', [win('five-hour')]);
    await m.refreshModels('/repo');

    await m.persistNow();

    const exists = async (name: string) => fs.access(path.join(workspace, name)).then(() => true, () => false);
    assert.strictEqual(await exists('usage.json'), false);
    assert.strictEqual(await exists('catalog.json'), false);
  });
});
