import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AccountCache } from '../../host/account-cache/account-cache';
import { openPlainDatabase, type SqlDb } from '../../memory/sqlite-driver';
import type { ModelInfo, UsageWindow } from '../../providers/types';

const win = (id: string, usedPercent = 10): UsageWindow => ({ id, label: id, usedPercent }) as UsageWindow;
const model = (id: string): ModelInfo => ({ id, displayName: id }) as ModelInfo;

suite('AccountCache', () => {
  let dir: string;
  let file: string;
  const caches: AccountCache[] = [];
  const dbs: SqlDb[] = [];
  const open = (p = file): AccountCache => { const c = AccountCache.open(p); caches.push(c); return c; };
  const raw = (): SqlDb => { const d = openPlainDatabase(file); dbs.push(d); return d; };

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'account-cache-'));
    file = path.join(dir, 'account.sqlite');
  });

  teardown(async () => {
    for (const c of caches.splice(0)) { c.close(); }
    for (const d of dbs.splice(0)) { d.close(); }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  test('round-trips usage and catalog rows', () => {
    const a = open();
    a.writeUsage({ instance: 'claude', windows: [win('5h')], fetchedAt: 100 });
    a.writeCatalog({ instance: 'claude', models: [model('m1')], fetchedAt: 100 });
    a.close();
    const b = open();
    assert.deepStrictEqual(b.readUsage(), [{ instance: 'claude', windows: [win('5h')], fetchedAt: 100 }]);
    assert.deepStrictEqual(b.readCatalog(), [{ instance: 'claude', models: [model('m1')], fetchedAt: 100 }]);
    assert.strictEqual(b.isEmpty(), false);
  });

  test('older write is ignored', () => {
    const a = open();
    a.writeUsage({ instance: 'x', windows: [win('new')], fetchedAt: 200 });
    a.writeUsage({ instance: 'x', windows: [win('old')], fetchedAt: 100 });
    assert.deepStrictEqual(a.readUsage().map((r) => r.windows?.[0]?.id), ['new']);
  });

  test('newer write wins from a second connection', () => {
    const a = open();
    const b = open();
    a.writeCatalog({ instance: 'x', models: [model('a')], fetchedAt: 100 });
    b.writeCatalog({ instance: 'x', models: [model('b')], fetchedAt: 200 });
    assert.deepStrictEqual(a.readCatalog().map((r) => r.models[0].id), ['b']);
  });

  test('tombstone is not resurrected by an older row', () => {
    const a = open();
    a.writeUsage({ instance: 'x', windows: null, fetchedAt: 300 });
    a.writeUsage({ instance: 'x', windows: [win('w')], fetchedAt: 200 });
    const rows = a.readUsage();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].windows, null);
  });

  test('empty model list is not written', () => {
    const a = open();
    a.writeCatalog({ instance: 'x', models: [], fetchedAt: 100 });
    assert.deepStrictEqual(a.readCatalog(), []);
    assert.strictEqual(a.isEmpty(), true);
  });

  test('hasChanged sees another connection write but not its own', () => {
    const a = open();
    const b = open();
    assert.strictEqual(a.hasChanged(), false);
    a.writeUsage({ instance: 'x', windows: [win('w')], fetchedAt: 1 });
    assert.strictEqual(a.hasChanged(), false);
    b.writeUsage({ instance: 'y', windows: [win('w')], fetchedAt: 1 });
    assert.strictEqual(a.hasChanged(), true);
    assert.strictEqual(a.hasChanged(), false);
  });

  test('newer schema is inert', () => {
    const d = raw();
    d.exec('CREATE TABLE usage(instance TEXT PRIMARY KEY, windows_json TEXT, fetched_at INTEGER NOT NULL);');
    d.exec("INSERT INTO usage VALUES('x', '[]', 1);");
    d.exec('PRAGMA user_version = 99;');
    const a = open();
    assert.strictEqual(a.available, false);
    assert.deepStrictEqual(a.readUsage(), []);
    a.writeUsage({ instance: 'y', windows: [win('w')], fetchedAt: 5 });
    const count = (d.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number }).n;
    assert.strictEqual(count, 1);
  });

  test('unopenable path is inert', () => {
    const a = open(dir);
    assert.strictEqual(a.available, false);
    assert.strictEqual(a.isEmpty(), true);
    assert.deepStrictEqual(a.readCatalog(), []);
    a.writeUsage({ instance: 'x', windows: null, fetchedAt: 1 });
    assert.strictEqual(a.hasChanged(), false);
  });

  test('malformed JSON row is skipped', () => {
    open().close();
    const d = raw();
    d.exec("INSERT INTO usage VALUES('bad', '{ not json', 1);");
    d.exec("INSERT INTO usage VALUES('obj', '{\"a\":1}', 1);");
    d.exec("INSERT INTO usage VALUES('ok', '[]', 1);");
    const a = open();
    assert.deepStrictEqual(a.readUsage().map((r) => r.instance), ['ok']);
  });
});
