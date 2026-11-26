import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import type { WireRecord } from '../../sync/api-types';
import { SyncStore } from '../../sync-server/store';

async function dbPath(): Promise<string> {
  return path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-sync-store-')), 'sync.sqlite');
}
const rec = (id: string): WireRecord => ({ recordId: id, epoch: 1, nonce: 'n', ciphertext: `c-${id}` });

suite('SyncStore', () => {
  test('the bootstrap code works once, and only before any device exists', async () => {
    const store = new SyncStore(await dbPath());
    store.setBootstrap('h1');
    assert.strictEqual(store.takeBootstrap('wrong'), false);
    assert.strictEqual(store.takeBootstrap('h1'), true);
    store.addDevice('desk', 'pk', 'tok');
    store.setBootstrap('h2');
    assert.strictEqual(store.takeBootstrap('h2'), false);
    store.close();
  });

  test('a revoked device no longer authenticates', async () => {
    const store = new SyncStore(await dbPath());
    const d = store.addDevice('desk', 'pk', 'tok');
    assert.strictEqual(store.deviceByTokenHash('tok')?.deviceId, d.deviceId);
    assert.strictEqual(store.revoke(d.deviceId), true);
    assert.strictEqual(store.deviceByTokenHash('tok'), undefined);
    assert.strictEqual(store.devices()[0].revokedAt !== undefined, true);
    store.close();
  });

  test('a pairing is claimed once and expires', async () => {
    let now = 1000;
    const store = new SyncStore(await dbPath(), () => now);
    store.createPairing('p1', 'd', 'blob', 2000);
    store.createPairing('p2', 'd', 'blob2', 2000);
    assert.deepStrictEqual(store.claimPairing('p1'), { wrapped: 'blob' });
    assert.strictEqual(store.claimPairing('p1'), 'gone');
    now = 2001;
    assert.strictEqual(store.claimPairing('p2'), 'gone');
    store.close();
  });

  test('append assigns seqs and dedupes retried record ids', async () => {
    const store = new SyncStore(await dbPath());
    assert.deepStrictEqual(store.append('d1', [rec('r1'), rec('r2'), rec('r3')]).map((a) => a.seq), [1, 2, 3]);
    assert.deepStrictEqual(store.append('d1', [rec('r2'), rec('r3'), rec('r4')]).map((a) => a.seq), [2, 3, 4]);
    assert.deepStrictEqual(store.streams(), [{ deviceId: 'd1', lastSeq: 4 }]);
    const page = store.read('d1', 2, 1);
    assert.deepStrictEqual(page.map((r) => [r.seq, r.recordId]), [[3, 'r3']]);
    store.close();
  });

  test('two stores on one file interleave appends without losing or duplicating', async () => {
    const file = await dbPath();
    const a = new SyncStore(file);
    const b = new SyncStore(file);
    for (let i = 0; i < 10; i++) {
      a.append('d1', [rec(`a${i}`)]);
      b.append('d1', [rec(`b${i}`), rec(`a${i}`)]);
    }
    const all = a.read('d1', 0, 500);
    assert.deepStrictEqual(all.map((r) => r.seq), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.strictEqual(new Set(all.map((r) => r.recordId)).size, 20);
    a.close();
    b.close();
  });

  test('epochs are create-only and sealed blobs are never replaced', async () => {
    const store = new SyncStore(await dbPath());
    assert.strictEqual(store.createEpoch(2, { d1: 's1', d2: 's2' }), true);
    assert.strictEqual(store.createEpoch(2, { d1: 'other' }), false);
    store.addSealed(2, { d1: 'replaced?', d3: 's3' });
    assert.deepStrictEqual(store.keysFor('d1'), [{ epoch: 2, sealed: 's1' }]);
    assert.deepStrictEqual(store.keysFor('d3'), [{ epoch: 2, sealed: 's3' }]);
    assert.deepStrictEqual(store.holders(), [{ epoch: 2, deviceIds: ['d1', 'd2', 'd3'] }]);
    store.close();
  });

  test('a reopened file keeps everything', async () => {
    const file = await dbPath();
    const first = new SyncStore(file);
    const d = first.addDevice('desk', 'pk', 'tok');
    first.append(d.deviceId, [rec('r1')]);
    first.close();
    const second = new SyncStore(file);
    assert.strictEqual(second.deviceByTokenHash('tok')?.name, 'desk');
    assert.strictEqual(second.read(d.deviceId, 0, 10).length, 1);
    second.close();
  });
});
