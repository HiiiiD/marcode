import { DatabaseSync } from 'node:sqlite';
import type { SessionId, TranscriptItem } from '../protocol/messages';
import type { MemoryDetail, MemoryHit, MemoryStore, SessionRecord, Summarizer } from './types';

/**
 * The slice of `TranscriptStore` this store needs to answer `fetch()` — see
 * Task 4. Declared structurally, not imported from `transcript-store.ts`, so
 * this module carries no `vscode` import in its graph and stays unit-testable
 * with a fake, the same boundary `SessionManagerLike` keeps in
 * `self-control-mcp-server.ts`.
 */
export interface TranscriptReader {
  tail(id: SessionId, limit?: number): Promise<{ items: TranscriptItem[]; hasMore: boolean }>;
}

/** How many items around the anchor `fetch()` returns. See Task 4. */
export const FETCH_WINDOW = 40;

/**
 * v1's only `MemoryStore`: one FTS5 row per session, upserted whenever that
 * session archives. Indexes at session granularity, not per-turn — a hit's
 * `itemId` anchors to the session's first item, and `fetch()` (Task 4) reads
 * forward from there. Per-turn granularity is future work (see the design
 * spec's Deferred section).
 *
 * JSONL transcripts remain the source of truth; this file is a rebuildable
 * cache — see the design spec's "Modularity / swap story".
 */
export class FtsMemoryStore implements MemoryStore {
  private readonly db: DatabaseSync;

  constructor(
    dbPath: string,
    private readonly summarizer: Summarizer,
    private readonly transcripts: TranscriptReader,
  ) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        title, summary, text,
        sessionId UNINDEXED, providerId UNINDEXED, cwd UNINDEXED,
        firstItemId UNINDEXED, closedAt UNINDEXED
      );
    `);
  }

  async index(record: SessionRecord): Promise<void> {
    const firstItemId = record.items[0]?.id;
    if (!firstItemId) { return; } // nothing to anchor a future fetch() to
    const summary = await this.summarizer.summarize(record.items);
    const text = record.items
      .map((i) => ('text' in i ? i.text : ''))
      .filter((t) => t.length > 0)
      .join('\n');

    this.db.prepare('DELETE FROM sessions_fts WHERE sessionId = ?').run(record.sessionId);
    this.db.prepare(`
      INSERT INTO sessions_fts (title, summary, text, sessionId, providerId, cwd, firstItemId, closedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.title, summary, text,
      record.sessionId, record.providerId, record.cwd, firstItemId, record.closedAt,
    );
  }

  /**
   * FTS5's `MATCH` clause has its own query grammar — column filters,
   * `AND`/`OR`/`NOT`, prefix `*`, phrase quoting — that runs BEFORE
   * tokenization, so punctuation a caller never chose to mean anything
   * special (`?`, `:`, `/`, `-`, `+`, an empty string) is a syntax error, not
   * "no results". Recall's contract (see the design spec's Error handling
   * section) is that a bad query returns no hits rather than throwing, so
   * every query is reduced to plain double-quoted barewords — FTS5's
   * implicit AND between quoted terms reproduces the old unquoted-AND
   * behaviour for ordinary alphanumeric queries — and any remaining SQL
   * error (a corrupt index, say) is caught rather than left to propagate.
   */
  async search(query: string, opts: { providerId?: string; limit?: number } = {}): Promise<MemoryHit[]> {
    const limit = opts.limit ?? 20;
    const providerId = opts.providerId ?? null;
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (terms.length === 0) { return []; }
    const match = terms.map((term) => `"${term}"`).join(' ');
    try {
      const rows = this.db.prepare(`
        SELECT sessionId, firstItemId, summary, closedAt, providerId, bm25(sessions_fts) AS rank
        FROM sessions_fts
        WHERE sessions_fts MATCH ?
          AND (? IS NULL OR providerId = ?)
        ORDER BY rank
        LIMIT ?
      `).all(match, providerId, providerId, limit) as Array<{
        sessionId: string; firstItemId: string; summary: string; closedAt: number;
        providerId: string; rank: number;
      }>;
      return rows.map((row) => ({
        sessionId: row.sessionId,
        itemId: row.firstItemId,
        snippet: row.summary,
        // bm25() is negative and lower-is-better; flip sign so a caller reads
        // "higher score is more relevant", the ordinary convention.
        score: -row.rank,
        ts: row.closedAt,
      }));
    } catch (err) {
      console.error('[mar-code] memory search failed', err);
      return [];
    }
  }

  async fetch(hit: { sessionId: SessionId; itemId: string }): Promise<MemoryDetail> {
    const { items } = await this.transcripts.tail(hit.sessionId, Number.MAX_SAFE_INTEGER);
    const at = items.findIndex((i) => i.id === hit.itemId);
    if (at < 0) { return { sessionId: hit.sessionId, items: [] }; }
    return { sessionId: hit.sessionId, items: items.slice(at, at + FETCH_WINDOW) };
  }
}
