import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { FtsMemoryStore } from '../../memory/fts/fts-memory-store';
import { readJsonlTranscript } from '../../memory/jsonl-transcript';
import { ProjectMemory } from '../../memory/project-memory';
import { openDatabase } from '../../memory/sqlite-driver';
import type { TranscriptItem } from '../../protocol/messages';

const noopReader = { tail: async () => ({ items: [] as TranscriptItem[], hasMore: false }) };
const user = (id: string, text: string): TranscriptItem => ({ id, ts: 0, role: 'user', text });

async function workspaces(...names: string[]): Promise<string[]> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-ws-'));
  return Promise.all(names.map(async (n) => {
    const dir = path.join(root, n);
    await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
    return dir;
  }));
}

async function indexIn(dir: string, id: string, text: string, projectId?: string): Promise<FtsMemoryStore> {
  const items = [user(`u-${id}`, text), { id: `a-${id}`, ts: 0, role: 'assistant', text: 'done' } as TranscriptItem];
  await fs.writeFile(path.join(dir, 'sessions', `${id}.jsonl`), items.map((i) => JSON.stringify(i)).join('\n') + '\n');
  const store = new FtsMemoryStore(path.join(dir, 'memory.sqlite'), noopReader);
  await store.index({ sessionId: id, providerId: 'claude', cwd: `/elsewhere/${id}`, closedAt: 1, items, projectId });
  return store;
}

function memoryFor(dir: string, opts?: ConstructorParameters<typeof ProjectMemory>[2]): ProjectMemory {
  return new ProjectMemory(new FtsMemoryStore(path.join(dir, 'memory.sqlite'), noopReader), dir, opts);
}

suite('ProjectMemory', () => {
  test("finds a sibling workspace's session of the same project, with its digest and transcript", async () => {
    const [a, b] = await workspaces('a', 'b');
    (await indexIn(b, 'sb', 'zebra migration plan', 'p')).close();
    const memory = memoryFor(a);
    const hits = await memory.search('zebra', { projectId: 'p' });
    assert.deepStrictEqual(hits.map((h) => h.sessionId), ['sb']);
    assert.strictEqual((await memory.getDigest('sb'))?.title.includes('zebra'), true);
    const detail = await memory.fetch(hits[0]);
    assert.deepStrictEqual(detail.items.map((i) => i.id), ['u-sb', 'a-sb']);
    memory.close();
  });

  test('another project, or a folder-only scope, never reaches a sibling', async () => {
    const [a, b] = await workspaces('a', 'b');
    (await indexIn(b, 'sb', 'zebra migration plan', 'p')).close();
    const memory = memoryFor(a);
    assert.deepStrictEqual(await memory.search('zebra', { projectId: 'q' }), []);
    assert.deepStrictEqual(await memory.search('zebra', { cwdWithin: '/elsewhere' }), []);
    memory.close();
  });

  test('local and sibling hits merge without duplicates', async () => {
    const [a, b] = await workspaces('a', 'b');
    (await indexIn(b, 'sb', 'zebra migration plan', 'p')).close();
    (await indexIn(a, 'sa', 'zebra rollout', 'p')).close();
    const memory = memoryFor(a);
    const ids = (await memory.search('zebra', { projectId: 'p' })).map((h) => h.sessionId);
    assert.deepStrictEqual(ids.slice().sort(), ['sa', 'sb']);
    memory.close();
  });

  test('a sibling without the projectId column, or with a garbage file, is skipped', async () => {
    const [a, old, junk] = await workspaces('a', 'old', 'junk');
    (await indexIn(a, 'sa', 'zebra rollout', 'p')).close();
    const db = openDatabase(path.join(old, 'memory.sqlite'));
    db.exec(`
      CREATE VIRTUAL TABLE sessions_fts USING fts5(title, summary, text, sessionId UNINDEXED, providerId UNINDEXED,
        cwd UNINDEXED, firstItemId UNINDEXED, closedAt UNINDEXED);
      CREATE TABLE digests (sessionId TEXT PRIMARY KEY, source TEXT NOT NULL, summarizerVersion INTEGER NOT NULL,
        forUpdatedAt INTEGER NOT NULL, json TEXT NOT NULL);
      INSERT INTO sessions_fts VALUES ('zebra', 'zebra', 'zebra', 'so', 'claude', '/x', 'u', 1);
    `);
    db.close();
    await fs.writeFile(path.join(junk, 'memory.sqlite'), 'not a database at all');
    const memory = memoryFor(a);
    assert.deepStrictEqual((await memory.search('zebra', { projectId: 'p' })).map((h) => h.sessionId), ['sa']);
    memory.close();
  });

  test('a locked sibling is skipped quickly and local hits still return', async () => {
    const [a, b] = await workspaces('a', 'b');
    (await indexIn(b, 'sb', 'zebra migration plan', 'p')).close();
    (await indexIn(a, 'sa', 'zebra rollout', 'p')).close();
    const holder = openDatabase(path.join(b, 'memory.sqlite'));
    holder.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; DELETE FROM digests WHERE sessionId = \'nobody\';');
    const memory = memoryFor(a);
    const started = Date.now();
    const ids = (await memory.search('zebra', { projectId: 'p' })).map((h) => h.sessionId);
    assert.strictEqual(Date.now() - started < 1000, true);
    assert.deepStrictEqual(ids, ['sa']);
    holder.exec('ROLLBACK');
    holder.close();
    memory.close();
  });

  test('a sibling whose query throws is skipped', async () => {
    const [a, b] = await workspaces('a', 'b');
    (await indexIn(b, 'sb', 'zebra migration plan', 'p')).close();
    (await indexIn(a, 'sa', 'zebra rollout', 'p')).close();
    const memory = memoryFor(a, {
      openReader: () => ({
        usable: true,
        search: () => { throw new Error('disk I/O error'); },
        getDigest: () => { throw new Error('disk I/O error'); },
        close: () => {},
      }),
    });
    assert.deepStrictEqual((await memory.search('zebra', { projectId: 'p' })).map((h) => h.sessionId), ['sa']);
    assert.strictEqual(await memory.getDigest('sb'), undefined);
    memory.close();
  });
});

suite('readJsonlTranscript', () => {
  test('a torn last line keeps the items before it; a missing file is empty', async () => {
    const [dir] = await workspaces('t');
    const file = path.join(dir, 'sessions', 's.jsonl');
    await fs.writeFile(file, `${JSON.stringify(user('u1', 'hi'))}\n{"id":"u2","ts":0,"ro`);
    assert.deepStrictEqual((await readJsonlTranscript(file)).map((i) => i.id), ['u1']);
    assert.deepStrictEqual(await readJsonlTranscript(path.join(dir, 'sessions', 'none.jsonl')), []);
  });
});
