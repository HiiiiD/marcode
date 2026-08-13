import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TranscriptStore } from '../../host/transcript-store';
import type { TranscriptItem } from '../../protocol/messages';

function item(id: string, text: string): TranscriptItem {
  return { id, ts: 1, role: 'user', text };
}

suite('TranscriptStore', () => {
  let dir: string;
  let store: TranscriptStore;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-store-'));
    store = new TranscriptStore(dir);
  });

  teardown(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('round-trips appended items through disk', async () => {
    store.append('s1', item('a', 'one'));
    store.append('s1', item('b', 'two'));
    await store.flush();

    const fresh = new TranscriptStore(dir);
    const { items, hasMore } = await fresh.tail('s1');
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].id, 'a');
    assert.strictEqual(items[1].id, 'b');
    assert.strictEqual(hasMore, false);
  });

  test('tail returns the last N items and reports more history', async () => {
    for (let i = 0; i < 10; i++) { store.append('s1', item(`i${i}`, `t${i}`)); }
    await store.flush();

    const { items, hasMore } = await store.tail('s1', 3);
    assert.deepStrictEqual(items.map((i) => i.id), ['i7', 'i8', 'i9']);
    assert.strictEqual(hasMore, true);
  });

  test('before pages backward from an item id', async () => {
    for (let i = 0; i < 10; i++) { store.append('s1', item(`i${i}`, `t${i}`)); }
    await store.flush();

    const { items, hasMore } = await store.before('s1', 'i7', 3);
    assert.deepStrictEqual(items.map((i) => i.id), ['i4', 'i5', 'i6']);
    assert.strictEqual(hasMore, true);

    const rest = await store.before('s1', 'i4', 10);
    assert.deepStrictEqual(rest.items.map((i) => i.id), ['i0', 'i1', 'i2', 'i3']);
    assert.strictEqual(rest.hasMore, false);
  });

  test('replace updates an item in place and survives reload', async () => {
    store.append('s1', {
      id: 'p1', ts: 1, role: 'permission', requestId: 'r1',
      name: 'Bash', input: {}, state: 'pending',
    });
    await store.flush();

    store.replace('s1', {
      id: 'p1', ts: 1, role: 'permission', requestId: 'r1',
      name: 'Bash', input: {}, state: 'allowed',
    });
    await store.flush();

    const fresh = new TranscriptStore(dir);
    const { items } = await fresh.tail('s1');
    assert.strictEqual(items.length, 1);
    assert.strictEqual((items[0] as { state: string }).state, 'allowed');
  });

  test('tail on an unknown session returns empty rather than throwing', async () => {
    const { items, hasMore } = await store.tail('missing');
    assert.deepStrictEqual(items, []);
    assert.strictEqual(hasMore, false);
  });

  test('index round-trips', async () => {
    await store.writeIndex({
      sessions: [{
        id: 's1', providerId: 'fake', model: 'fake-large', title: 'T', cwd: '/tmp',
        status: 'idle', permissionMode: 'default',
        usage: { inputTokens: 0, outputTokens: 0 },
        archived: false, createdAt: 1, updatedAt: 1,
      }],
      layout: { orientation: 'vertical', panes: [{ sessionId: 's1', size: 100 }] },
    });

    const fresh = new TranscriptStore(dir);
    const index = await fresh.readIndex();
    assert.strictEqual(index.sessions.length, 1);
    assert.strictEqual(index.sessions[0].id, 's1');
    assert.strictEqual(index.layout.panes[0].sessionId, 's1');
  });

  test('readIndex on a fresh directory returns an empty index', async () => {
    const index = await store.readIndex();
    assert.deepStrictEqual(index.sessions, []);
    assert.deepStrictEqual(index.layout, { orientation: 'vertical', panes: [] });
  });
});
