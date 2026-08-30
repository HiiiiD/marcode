import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { ExtractiveSummarizer } from '../../memory/extractive-summarizer';
import { FtsMemoryStore } from '../../memory/fts-memory-store';
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
  test('search() finds an indexed session by keyword', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), new ExtractiveSummarizer(), noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', title: 'Untitled', closedAt: 1000,
      items: [userItem('u1', 'Investigate the flaky login test on CI')],
    });
    const hits = await store.search('flaky login');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].sessionId, 's1');
    assert.strictEqual(hits[0].itemId, 'u1');
    assert.strictEqual(hits[0].snippet.includes('flaky login test'), true);
  });

  test('search() returns nothing for an unrelated query', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), new ExtractiveSummarizer(), noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', title: 'Untitled', closedAt: 1000,
      items: [userItem('u1', 'Investigate the flaky login test on CI')],
    });
    const hits = await store.search('database migration');
    assert.strictEqual(hits.length, 0);
  });

  test('search() filters by providerId', async () => {
    const dbPath = await tempDbPath();
    const store = new FtsMemoryStore(dbPath, new ExtractiveSummarizer(), noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', title: 'Untitled', closedAt: 1000,
      items: [userItem('u1', 'Investigate the flaky login test')],
    });
    await store.index({
      sessionId: 's2', providerId: 'codex', cwd: '/repo', title: 'Untitled', closedAt: 2000,
      items: [userItem('u2', 'Investigate the flaky login test')],
    });
    const hits = await store.search('flaky login', { providerId: 'codex' });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].sessionId, 's2');
  });

  test('re-indexing the same sessionId replaces, not duplicates', async () => {
    const dbPath = await tempDbPath();
    const store = new FtsMemoryStore(dbPath, new ExtractiveSummarizer(), noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', title: 'Untitled', closedAt: 1000,
      items: [userItem('u1', 'Investigate the flaky login test')],
    });
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', title: 'Untitled', closedAt: 2000,
      items: [userItem('u2', 'Investigate the flaky login test')],
    });
    const hits = await store.search('flaky login');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].itemId, 'u2');
  });

  test('search() respects the limit option', async () => {
    const dbPath = await tempDbPath();
    const store = new FtsMemoryStore(dbPath, new ExtractiveSummarizer(), noopReader);
    for (const n of [1, 2, 3]) {
      await store.index({
        sessionId: `s${n}`, providerId: 'claude', cwd: '/repo', title: 'Untitled', closedAt: n,
        items: [userItem(`u${n}`, 'Investigate the flaky login test')],
      });
    }
    const hits = await store.search('flaky login', { limit: 2 });
    assert.strictEqual(hits.length, 2);
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
      const store = new FtsMemoryStore(await tempDbPath(), new ExtractiveSummarizer(), noopReader);
      await store.index({
        sessionId: 's1', providerId: 'claude', cwd: '/repo', title: 'Untitled', closedAt: 1000,
        items: [userItem('u1', 'Investigate the flaky login test on CI')],
      });
      const hits = await store.search(query);
      assert.deepStrictEqual(hits, []);
    });
  }
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
    const store = new FtsMemoryStore(await tempDbPath(), new ExtractiveSummarizer(), fakeReader(items));
    await store.index({ sessionId: 's1', providerId: 'claude', cwd: '/repo', title: 'Untitled', closedAt: 1, items });
    const [hit] = await store.search('first');
    const detail = await store.fetch(hit);
    assert.strictEqual(detail.sessionId, 's1');
    assert.strictEqual(detail.items.length, 3);
    assert.strictEqual(detail.items[0].id, 'u1');
  });

  test('returns an empty slice when the itemId is no longer in the transcript', async () => {
    const items = [userItem('u1', 'first')];
    const store = new FtsMemoryStore(await tempDbPath(), new ExtractiveSummarizer(), fakeReader(items));
    await store.index({ sessionId: 's1', providerId: 'claude', cwd: '/repo', title: 'Untitled', closedAt: 1, items });
    const detail = await store.fetch({ sessionId: 's1', itemId: 'gone' });
    assert.strictEqual(detail.items.length, 0);
  });
});
