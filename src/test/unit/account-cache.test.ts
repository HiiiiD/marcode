import * as assert from 'assert';
import { spawn } from 'child_process';
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
  let warnings: string[];
  let realWarn: typeof console.warn;
  const dbs: SqlDb[] = [];
  const open = (p = file): AccountCache => { const c = AccountCache.open(p); caches.push(c); return c; };
  const raw = (): SqlDb => { const d = openPlainDatabase(file); dbs.push(d); return d; };

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'account-cache-'));
    file = path.join(dir, 'account.sqlite');
    warnings = [];
    realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
  });

  teardown(async () => {
    console.warn = realWarn;
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

  test('a newer real row replaces a tombstone', () => {
    const a = open();
    a.writeUsage({ instance: 'x', windows: null, fetchedAt: 100 });
    a.writeUsage({ instance: 'x', windows: [win('w')], fetchedAt: 200 });
    assert.deepStrictEqual(a.readUsage(), [{ instance: 'x', windows: [win('w')], fetchedAt: 200 }]);
  });

  test('a newer tombstone replaces a real row', () => {
    const a = open();
    a.writeUsage({ instance: 'x', windows: [win('w')], fetchedAt: 100 });
    a.writeUsage({ instance: 'x', windows: null, fetchedAt: 200 });
    assert.deepStrictEqual(a.readUsage(), [{ instance: 'x', windows: null, fetchedAt: 200 }]);
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

  test('newer schema keeps its journal mode', () => {
    const d = raw();
    d.exec('PRAGMA user_version = 99;');
    open();
    assert.strictEqual((d.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'delete');
  });

  test('a failed switch to WAL is not fatal', async () => {
    const d = raw();
    d.exec('CREATE TABLE usage(instance TEXT PRIMARY KEY, windows_json TEXT, fetched_at INTEGER NOT NULL);');
    d.exec('CREATE TABLE catalog(instance TEXT PRIMARY KEY, models_json TEXT NOT NULL, fetched_at INTEGER NOT NULL);');
    d.exec("INSERT INTO usage VALUES('x', '[]', 1);");
    d.exec('PRAGMA user_version = 1;');
    d.close();
    dbs.splice(dbs.indexOf(d), 1);

    const holder = await holdWriteLock(file);
    let a: AccountCache;
    try {
      a = AccountCache.open(file, { busyTimeoutMs: 100 });
      caches.push(a);
      assert.strictEqual(a.available, true);
      assert.deepStrictEqual(a.readUsage(), [{ instance: 'x', windows: [], fetchedAt: 1 }]);
      a.writeUsage({ instance: 'z', windows: [win('w')], fetchedAt: 2 });
    } finally {
      await holder.release();
    }
    a.writeUsage({ instance: 'y', windows: [win('w')], fetchedAt: 2 });
    assert.deepStrictEqual(a.readUsage().map((r) => r.instance).sort(), ['x', 'y']);
    assert.deepStrictEqual(warnings, [
      '[mar-code] account-cache: could not switch to WAL, continuing without it',
      '[mar-code] account-cache: write dropped',
    ]);
  });

  test('unopenable path is inert', () => {
    const a = open(dir);
    assert.strictEqual(a.available, false);
    assert.deepStrictEqual(warnings, ['[mar-code] account-cache: could not open, plan usage will not be shared']);
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

const LOCK_HOLDER = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('BEGIN IMMEDIATE');
const done = () => { try { db.exec('ROLLBACK'); db.close(); } finally { process.exit(0); } };
setTimeout(done, 10000);
process.stdin.on('end', done);
process.stdin.resume();
console.log('locked');
`;

/** Another process holding a RESERVED lock, so a journal-mode switch here cannot complete. */
async function holdWriteLock(dbPath: string): Promise<{ release(): Promise<void> }> {
  const child = spawn(process.execPath, ['--no-warnings', '-e', LOCK_HOLDER, dbPath], { stdio: 'pipe' });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('exit', (code) => reject(new Error(`lock holder exited early (${code}): ${stderr}`)));
  });
  return {
    release: async () => { child.stdin.end(); await exited; },
  };
}
