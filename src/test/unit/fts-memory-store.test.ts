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
});
