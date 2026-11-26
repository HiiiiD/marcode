import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { SyncState } from '../../sync/sync-state';

const dbPath = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-sync-state-')), 'state.sqlite');
const meta = (forUpdatedAt: number, source: 'extractive' | 'llm' = 'extractive') => ({ forUpdatedAt, source, summarizerVersion: 1 });

suite('SyncState', () => {
  test('the outbox keeps order and removes exactly what it is told', async () => {
    const s = new SyncState(await dbPath());
    const a = s.enqueue({ n: 1 });
    const b = s.enqueue({ n: 2 });
    s.enqueue({ n: 3 });
    assert.deepStrictEqual(s.peek(10).map((r) => r.payload), [{ n: 1 }, { n: 2 }, { n: 3 }]);
    assert.strictEqual(/^[0-9a-f]{32}$/.test(a), true);
    s.remove([a, b]);
    assert.deepStrictEqual(s.peek(10).map((r) => r.payload), [{ n: 3 }]);
    assert.strictEqual(s.outboxSize(), 1);
    s.close();
  });

  test('two instances on one file share the outbox', async () => {
    const file = await dbPath();
    const x = new SyncState(file);
    const y = new SyncState(file);
    x.enqueue({ from: 'x' });
    y.enqueue({ from: 'y' });
    assert.deepStrictEqual(x.peek(10).map((r) => r.payload), [{ from: 'x' }, { from: 'y' }]);
    x.close();
    y.close();
  });

  test('published means the same digest, so an llm upgrade is not yet published', async () => {
    const s = new SyncState(await dbPath());
    s.markPublished('s1', meta(5));
    assert.strictEqual(s.wasPublished('s1', meta(5)), true);
    assert.strictEqual(s.wasPublished('s1', meta(5, 'llm')), false);
    assert.strictEqual(s.wasPublished('s1', meta(6)), false);
    s.clearPublished('s1');
    assert.strictEqual(s.wasPublished('s1', meta(5)), false);
    s.close();
  });

  test('cursors never move backwards and everything survives a reopen', async () => {
    const file = await dbPath();
    const s = new SyncState(file);
    assert.strictEqual(s.cursor('d1'), 0);
    s.setCursor('d1', 5);
    s.setCursor('d1', 3);
    assert.strictEqual(s.cursor('d1'), 5);
    s.enqueue({ keep: true });
    s.markPublished('s1', meta(1));
    s.close();
    const again = new SyncState(file);
    assert.strictEqual(again.cursor('d1'), 5);
    assert.strictEqual(again.outboxSize(), 1);
    assert.strictEqual(again.wasPublished('s1', meta(1)), true);
    again.close();
  });
});
