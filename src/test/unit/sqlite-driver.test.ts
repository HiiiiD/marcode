import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { assertFts5, openDatabase, wrapDatabase, type RawDatabase } from '../../memory/sqlite-driver';

function fakeRaw(over: Partial<RawDatabase> = {}): RawDatabase {
  return {
    exec: () => undefined,
    prepare: () => ({ get: () => null, all: () => [], run: () => undefined }),
    close: () => undefined,
    ...over,
  };
}

suite('sqlite-driver', () => {
  test('wrapDatabase turns a null row into undefined', () => {
    const db = wrapDatabase(fakeRaw());
    assert.strictEqual(db.prepare('SELECT 1').get(), undefined);
  });

  test('wrapDatabase passes a found row through untouched', () => {
    const row = { json: '{}' };
    const db = wrapDatabase(fakeRaw({ prepare: () => ({ get: () => row, all: () => [row], run: () => undefined }) }));
    assert.strictEqual(db.prepare('SELECT 1').get(), row);
    assert.deepStrictEqual(db.prepare('SELECT 1').all(), [row]);
  });

  test('wrapDatabase finalizes a statement after each use so bun:sqlite can release the file', () => {
    let finalized = 0;
    const statement = { get: () => null, all: () => [], run: () => undefined, finalize: () => { finalized++; } };
    const db = wrapDatabase(fakeRaw({ prepare: () => statement }));
    db.prepare('SELECT 1').get();
    db.prepare('SELECT 1').all();
    db.prepare('SELECT 1').run();
    assert.strictEqual(finalized, 3);
  });

  test('wrapDatabase finalizes even when the statement throws', () => {
    let finalized = 0;
    const statement = { get: () => { throw new Error('boom'); }, all: () => [], run: () => undefined, finalize: () => { finalized++; } };
    const db = wrapDatabase(fakeRaw({ prepare: () => statement }));
    assert.throws(() => db.prepare('SELECT 1').get(), /boom/);
    assert.strictEqual(finalized, 1);
  });

  test('assertFts5 explains a build without FTS5', () => {
    const db = wrapDatabase(fakeRaw({ exec: () => { throw new Error('no such module: fts5'); } }));
    assert.throws(() => assertFts5(db), /FTS5 is unavailable: no such module: fts5/);
  });

  test('openDatabase round-trips on this runtime and reports no row as undefined', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-driver-'));
    const db = openDatabase(path.join(dir, 'x.sqlite'));
    db.exec('CREATE TABLE t (a TEXT PRIMARY KEY, n INTEGER)');
    db.prepare('INSERT INTO t (a, n) VALUES (?, ?)').run('k', 7);
    assert.deepStrictEqual({ ...(db.prepare('SELECT n FROM t WHERE a = ?').get('k') as object) }, { n: 7 });
    assert.strictEqual(db.prepare('SELECT n FROM t WHERE a = ?').get('missing'), undefined);
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
