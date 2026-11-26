import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { FtsMemoryStore } from '../../memory/fts/fts-memory-store';
import { openDatabase } from '../../memory/sqlite-driver';
import type { TranscriptItem } from '../../protocol/messages';

const noopReader = { tail: async () => ({ items: [] as TranscriptItem[], hasMore: false }) };

function userItem(id: string, text: string): TranscriptItem {
  return { id, ts: 0, role: 'user', text };
}

async function tempDbPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-memory-'));
  return path.join(dir, 'memory.sqlite');
}

suite('FtsMemoryStore', () => {
  test('two stores on one file both index and each finds the other\'s sessions', async () => {
    const file = await tempDbPath();
    const a = new FtsMemoryStore(file, noopReader);
    const b = new FtsMemoryStore(file, noopReader);
    await a.index({ sessionId: 'sa', providerId: 'claude', cwd: '/repo', closedAt: 1, items: [userItem('u1', 'zebra migration plan')] });
    await b.index({ sessionId: 'sb', providerId: 'claude', cwd: '/repo', closedAt: 2, items: [userItem('u2', 'giraffe rollout notes')] });
    assert.deepStrictEqual((await a.search('giraffe')).map((h) => h.sessionId), ['sb']);
    assert.deepStrictEqual((await b.search('zebra')).map((h) => h.sessionId), ['sa']);
    a.close();
    b.close();
  });

  test('search() finds an indexed session by keyword', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1000,
      items: [userItem('u1', 'Investigate the flaky login test on CI')],
    });
    const hits = await store.search('flaky login');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].sessionId, 's1');
    assert.strictEqual(hits[0].itemId, 'u1');
    assert.strictEqual(hits[0].snippet.includes('flaky login test'), true);
  });

  test('search() returns nothing for an unrelated query', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1000,
      items: [userItem('u1', 'Investigate the flaky login test on CI')],
    });
    const hits = await store.search('database migration');
    assert.strictEqual(hits.length, 0);
  });

  test("search() with match 'any' finds a session sharing only some terms", async () => {
    const store = new FtsMemoryStore(await tempDbPath(), noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1000,
      items: [userItem('u1', 'Investigate the flaky login test on CI')],
    });
    assert.strictEqual((await store.search('flaky checkout payment')).length, 0);
    const hits = await store.search('flaky checkout payment', { match: 'any' });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].sessionId, 's1');
  });

  test('search() filters by providerId', async () => {
    const dbPath = await tempDbPath();
    const store = new FtsMemoryStore(dbPath, noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1000,
      items: [userItem('u1', 'Investigate the flaky login test')],
    });
    await store.index({
      sessionId: 's2', providerId: 'codex', cwd: '/repo', closedAt: 2000,
      items: [userItem('u2', 'Investigate the flaky login test')],
    });
    const hits = await store.search('flaky login', { providerId: 'codex' });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].sessionId, 's2');
  });

  test('re-indexing the same sessionId replaces, not duplicates', async () => {
    const dbPath = await tempDbPath();
    const store = new FtsMemoryStore(dbPath, noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1000,
      items: [userItem('u1', 'Investigate the flaky login test')],
    });
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 2000,
      items: [userItem('u2', 'Investigate the flaky login test')],
    });
    const hits = await store.search('flaky login');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].itemId, 'u2');
  });

  test('search() respects the limit option', async () => {
    const dbPath = await tempDbPath();
    const store = new FtsMemoryStore(dbPath, noopReader);
    for (const n of [1, 2, 3]) {
      await store.index({
        sessionId: `s${n}`, providerId: 'claude', cwd: '/repo', closedAt: n,
        items: [userItem(`u${n}`, 'Investigate the flaky login test')],
      });
    }
    const hits = await store.search('flaky login', { limit: 2 });
    assert.strictEqual(hits.length, 2);
  });

  test('forget() removes a session\'s row from search results', async () => {
    const dbPath = await tempDbPath();
    const store = new FtsMemoryStore(dbPath, noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1000,
      items: [userItem('u1', 'Investigate the flaky login test on CI')],
    });
    await store.forget('s1');
    const hits = await store.search('flaky login');
    assert.strictEqual(hits.length, 0);
  });

  // FTS5's MATCH clause has its own query grammar that runs before
  // tokenization, so punctuation a caller never meant as syntax must not
  // reach it raw. Each of these throws in real node:sqlite if search()
  // passes the query straight through to MATCH.
  for (const query of [
    'how did we fix the login bug?',
    'auth: login',
    'C++ build',
    'node_modules/foo',
    'fix -bug',
    '',
  ]) {
    test(`search() returns [] rather than throwing for ${JSON.stringify(query)}`, async () => {
      const store = new FtsMemoryStore(await tempDbPath(), noopReader);
      await store.index({
        sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1000,
        items: [userItem('u1', 'Investigate the flaky login test on CI')],
      });
      const hits = await store.search(query);
      assert.deepStrictEqual(hits, []);
    });
  }
});

suite('FtsMemoryStore schema version', () => {
  test('a schema-version bump drops and rebuilds the table, discarding old rows', async () => {
    const dbPath = await tempDbPath();
    const first = new FtsMemoryStore(dbPath, noopReader, 1);
    await first.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1000,
      items: [userItem('u1', 'Investigate the flaky login test on CI')],
    });
    assert.strictEqual((await first.search('flaky login')).length, 1);

    const second = new FtsMemoryStore(dbPath, noopReader, 2);
    const hits = await second.search('flaky login');
    assert.strictEqual(hits.length, 0);
  });

  test('reopening with the same schema version keeps prior rows', async () => {
    const dbPath = await tempDbPath();
    const first = new FtsMemoryStore(dbPath, noopReader, 1);
    await first.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1000,
      items: [userItem('u1', 'Investigate the flaky login test on CI')],
    });

    const second = new FtsMemoryStore(dbPath, noopReader, 1);
    const hits = await second.search('flaky login');
    assert.strictEqual(hits.length, 1);
  });
});

function fakeReader(items: TranscriptItem[]): { tail: (id: string, limit?: number) => Promise<{ items: TranscriptItem[]; hasMore: boolean }> } {
  return {
    tail: async (_id, limit = 100) => {
      const start = Math.max(0, items.length - limit);
      return { items: items.slice(start), hasMore: start > 0 };
    },
  };
}

suite('FtsMemoryStore.fetch()', () => {
  test('returns a bounded slice starting at the hit\'s itemId', async () => {
    const items = [userItem('u1', 'first'), userItem('u2', 'second'), userItem('u3', 'third')];
    const store = new FtsMemoryStore(await tempDbPath(), fakeReader(items));
    await store.index({ sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1, items });
    const [hit] = await store.search('first');
    const detail = await store.fetch(hit);
    assert.strictEqual(detail.sessionId, 's1');
    assert.strictEqual(detail.items.length, 3);
    assert.strictEqual(detail.items[0].id, 'u1');
  });

  test('returns an empty slice when the itemId is no longer in the transcript', async () => {
    const items = [userItem('u1', 'first')];
    const store = new FtsMemoryStore(await tempDbPath(), fakeReader(items));
    await store.index({ sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1, items });
    const detail = await store.fetch({ sessionId: 's1', itemId: 'gone' });
    assert.strictEqual(detail.items.length, 0);
  });
});

suite('FtsMemoryStore cwd scope', () => {
  const index = async (store: FtsMemoryStore, id: string, cwd: string) => store.index({
    sessionId: id, providerId: 'claude', cwd, closedAt: 1,
    items: [userItem(`u-${id}`, 'Investigate the flaky login test')],
  });

  test('hits carry the cwd the session ran in', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), noopReader);
    await index(store, 's1', '/ws/app');
    assert.strictEqual((await store.search('flaky login'))[0].cwd, '/ws/app');
  });

  test('cwdWithin keeps only sessions started inside that folder', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), noopReader);
    await index(store, 'in', '/ws/app/packages/api');
    await index(store, 'sibling', '/ws/app-two');
    await index(store, 'elsewhere', '/other');
    const hits = await store.search('flaky login', { cwdWithin: '/ws/app' });
    assert.deepStrictEqual(hits.map((h) => h.sessionId), ['in']);
  });

  test('cwdWithin still fills the limit from inside the folder', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), noopReader);
    for (let i = 0; i < 30; i++) { await index(store, `out${i}`, '/other'); }
    await index(store, 'in', '/ws/app');
    const hits = await store.search('flaky login', { cwdWithin: '/ws/app', limit: 1 });
    assert.deepStrictEqual(hits.map((h) => h.sessionId), ['in']);
  });
});

suite('FtsMemoryStore digests', () => {
  test('index() stores a digest that getDigest() and digestMeta() return', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1000,
      items: [userItem('u1', 'Fix the flaky login test')],
    });
    const digest = await store.getDigest('s1');
    assert.strictEqual(digest?.title, 'Fix the flaky login test');
    assert.strictEqual(digest?.source, 'extractive');
    const meta = (await store.digestMeta()).get('s1');
    assert.strictEqual(meta?.forUpdatedAt, 1000);
  });

  test('an explicit digest wins over the extractive default and is what search shows', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), noopReader);
    const items = [userItem('u1', 'Fix the flaky login test')];
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1000, items,
      digest: {
        title: 'Login retry', request: 'Fix the flaky login test', outcome: 'Added a retry to the auth fixture',
        filesEdited: [], source: 'llm', summarizerVersion: 1, forUpdatedAt: 1000,
      },
    });
    const hits = await store.search('flaky login');
    assert.strictEqual(hits[0].snippet, 'Login retry → Added a retry to the auth fixture');
    assert.strictEqual((await store.digestMeta()).get('s1')?.source, 'llm');
  });

  test('forget() removes the digest as well', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1000,
      items: [userItem('u1', 'Fix it')],
    });
    await store.forget('s1');
    assert.strictEqual(await store.getDigest('s1'), undefined);
    assert.strictEqual((await store.digestMeta()).size, 0);
  });

  test('a schema bump drops the digests table with the FTS table', async () => {
    const dbPath = await tempDbPath();
    const first = new FtsMemoryStore(dbPath, noopReader, 1);
    await first.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1000,
      items: [userItem('u1', 'Fix it')],
    });
    const second = new FtsMemoryStore(dbPath, noopReader, 2);
    assert.strictEqual((await second.digestMeta()).size, 0);
  });
});

suite('FtsMemoryStore project scope', () => {
  const index = (store: FtsMemoryStore, id: string, cwd: string, projectId?: string) => store.index({
    sessionId: id, providerId: 'claude', cwd, closedAt: 1, projectId,
    items: [userItem(`u-${id}`, 'Investigate the flaky login test')],
  });

  test('projectId finds a same-project row from another cwd and nothing else', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), noopReader);
    await index(store, 'clone', '/elsewhere/clone', 'github.com/a/b');
    await index(store, 'other', '/unrelated', 'github.com/x/y');
    await index(store, 'none', '/nowhere');
    const hits = await store.search('flaky login', { projectId: 'github.com/a/b' });
    assert.deepStrictEqual(hits.map((h) => h.sessionId), ['clone']);
    assert.strictEqual(hits[0].projectId, 'github.com/a/b');
  });

  test('cwdWithin and projectId together return the union', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), noopReader);
    await index(store, 'inside', '/ws/app');
    await index(store, 'clone', '/elsewhere/clone', 'github.com/a/b');
    await index(store, 'other', '/unrelated', 'github.com/x/y');
    const hits = await store.search('flaky login', { cwdWithin: '/ws/app', projectId: 'github.com/a/b' });
    assert.deepStrictEqual(hits.map((h) => h.sessionId).sort(), ['clone', 'inside']);
  });

  test('setProject makes an indexed session findable by that project', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), noopReader);
    await index(store, 's1', '/old/path');
    await store.setProject('s1', 'github.com/a/b');
    assert.deepStrictEqual((await store.search('flaky login', { projectId: 'github.com/a/b' })).map((h) => h.sessionId), ['s1']);
    await store.setProject('missing', 'github.com/a/b');
  });

  test("an older build's v2 file gains the column, keeps its llm digest, and stays writable the old way", async () => {
    const dbPath = await tempDbPath();
    const old = openDatabase(dbPath);
    old.exec(`
      PRAGMA user_version = 2;
      CREATE VIRTUAL TABLE sessions_fts USING fts5(
        title, summary, text,
        sessionId UNINDEXED, providerId UNINDEXED, cwd UNINDEXED,
        firstItemId UNINDEXED, closedAt UNINDEXED
      );
      CREATE TABLE digests (
        sessionId TEXT PRIMARY KEY, source TEXT NOT NULL, summarizerVersion INTEGER NOT NULL,
        forUpdatedAt INTEGER NOT NULL, json TEXT NOT NULL
      );
    `);
    const llm = { title: 'Fix login', request: 'r', outcome: 'o', learned: [], decisions: [], files: [], source: 'llm', summarizerVersion: 1, forUpdatedAt: 5 };
    old.prepare('INSERT INTO digests (sessionId, source, summarizerVersion, forUpdatedAt, json) VALUES (?, ?, ?, ?, ?)')
      .run('s1', 'llm', 1, 5, JSON.stringify(llm));
    old.close();

    const store = new FtsMemoryStore(dbPath, noopReader);
    assert.strictEqual((await store.getDigest('s1'))?.source, 'llm');
    store.close();

    const again = openDatabase(dbPath);
    assert.strictEqual((again.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
    again.prepare('INSERT INTO digests (sessionId, source, summarizerVersion, forUpdatedAt, json) VALUES (?, ?, ?, ?, ?)')
      .run('s2', 'extractive', 1, 6, JSON.stringify({ ...llm, source: 'extractive' }));
    again.close();
  });
});
