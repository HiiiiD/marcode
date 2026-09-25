import { DatabaseSync } from 'node:sqlite';
import type { SessionId, TranscriptItem } from '../protocol/messages';
import { isWithin } from '../shared/path-scope';
import { extractiveDigest, indexLine, type SessionDigest } from './digest';
import type { DigestMeta, MemoryDetail, MemoryHit, MemoryStore, SessionRecord } from './types';

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
 * Bumped whenever `sessions_fts`'s column list changes. Checked against the
 * database's own `PRAGMA user_version` at construction: a mismatch means the
 * table on disk was built by an older shape of this class, and every insert
 * against it would fail with a column-count mismatch rather than "no
 * results" — the same silent-corruption risk `search()` guards against for
 * a malformed query. This store is a rebuildable cache (see the design
 * spec's "Modularity / swap story"), so the fix is to drop and rebuild it,
 * never to migrate it.
 */
const SCHEMA_VERSION = 2;
const SCOPED_FETCH = 500;

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
    private readonly transcripts: TranscriptReader,
    schemaVersion: number = SCHEMA_VERSION,
  ) {
    this.db = new DatabaseSync(dbPath);

    // `CREATE VIRTUAL TABLE IF NOT EXISTS` is a no-op once the table already
    // exists on disk, so a future column-list change would otherwise leave
    // an old-shaped table in place and fail every insert with a
    // column-count mismatch. `PRAGMA user_version` is SQLite's own built-in
    // schema-version slot; a mismatch means the on-disk table was built by a
    // different shape of this class, so it is dropped and rebuilt rather
    // than migrated — this store is a cache, never a source of truth.
    const { user_version: onDiskVersion } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    if (onDiskVersion !== schemaVersion) {
      this.db.exec('DROP TABLE IF EXISTS sessions_fts; DROP TABLE IF EXISTS digests;');
      this.db.exec(`PRAGMA user_version = ${schemaVersion};`);
    }
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        title, summary, text,
        sessionId UNINDEXED, providerId UNINDEXED, cwd UNINDEXED,
        firstItemId UNINDEXED, closedAt UNINDEXED
      );
      CREATE TABLE IF NOT EXISTS digests (
        sessionId TEXT PRIMARY KEY, source TEXT NOT NULL, summarizerVersion INTEGER NOT NULL,
        forUpdatedAt INTEGER NOT NULL, json TEXT NOT NULL
      );
    `);
  }

  async index(record: SessionRecord): Promise<void> {
    const digest = record.digest ?? extractiveDigest(record.items, record.closedAt);
    const firstItemId = record.items[0]?.id;
    if (!firstItemId || !digest) { return; } // nothing to anchor a future fetch() to
    const text = record.items
      .map((i) => ('text' in i ? i.text : ''))
      .filter((t) => t.length > 0)
      .join('\n');

    this.db.exec('BEGIN');
    try {
      this.deleteRows(record.sessionId);
      this.db.prepare(`
        INSERT INTO sessions_fts (title, summary, text, sessionId, providerId, cwd, firstItemId, closedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        digest.title, indexLine(digest), text,
        record.sessionId, record.providerId, record.cwd, firstItemId, record.closedAt,
      );
      this.db.prepare(`
        INSERT INTO digests (sessionId, source, summarizerVersion, forUpdatedAt, json)
        VALUES (?, ?, ?, ?, ?)
      `).run(record.sessionId, digest.source, digest.summarizerVersion, digest.forUpdatedAt, JSON.stringify(digest));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Erases `sessionId`'s row and digest, if any. See `MemoryStore.forget`. */
  async forget(sessionId: SessionId): Promise<void> {
    this.deleteRows(sessionId);
  }

  private deleteRows(sessionId: SessionId): void {
    this.db.prepare('DELETE FROM sessions_fts WHERE sessionId = ?').run(sessionId);
    this.db.prepare('DELETE FROM digests WHERE sessionId = ?').run(sessionId);
  }

  async getDigest(sessionId: SessionId): Promise<SessionDigest | undefined> {
    const row = this.db.prepare('SELECT json FROM digests WHERE sessionId = ?').get(sessionId) as
      { json: string } | undefined;
    return row ? JSON.parse(row.json) as SessionDigest : undefined;
  }

  async digestMeta(): Promise<Map<SessionId, DigestMeta>> {
    const rows = this.db.prepare(
      'SELECT sessionId, source, summarizerVersion, forUpdatedAt FROM digests',
    ).all() as Array<{
      sessionId: string; source: 'extractive' | 'llm'; summarizerVersion: number; forUpdatedAt: number;
    }>;
    return new Map(rows.map((r) => [r.sessionId, {
      source: r.source, summarizerVersion: r.summarizerVersion, forUpdatedAt: r.forUpdatedAt,
    }]));
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
  async search(
    query: string,
    opts: { providerId?: string; limit?: number; match?: 'all' | 'any'; cwdWithin?: string } = {},
  ): Promise<MemoryHit[]> {
    const limit = opts.limit ?? 20;
    // The folder filter runs in JS (path comparison is platform-dependent), so over-fetch to still fill `limit`.
    const fetchLimit = opts.cwdWithin ? Math.max(limit, SCOPED_FETCH) : limit;
    const providerId = opts.providerId ?? null;
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (terms.length === 0) { return []; }
    const match = terms.map((term) => `"${term}"`).join(opts.match === 'any' ? ' OR ' : ' ');
    try {
      const rows = this.db.prepare(`
        SELECT sessionId, firstItemId, summary, closedAt, providerId, cwd, bm25(sessions_fts) AS rank
        FROM sessions_fts
        WHERE sessions_fts MATCH ?
          AND (? IS NULL OR providerId = ?)
        ORDER BY rank
        LIMIT ?
      `).all(match, providerId, providerId, fetchLimit) as Array<{
        sessionId: string; firstItemId: string; summary: string; closedAt: number;
        providerId: string; cwd: string; rank: number;
      }>;
      const inScope = opts.cwdWithin === undefined
        ? rows
        : rows.filter((row) => isWithin(opts.cwdWithin as string, row.cwd));
      return inScope.slice(0, limit).map((row) => ({
        sessionId: row.sessionId,
        itemId: row.firstItemId,
        snippet: row.summary,
        // bm25() is negative and lower-is-better; flip sign so a caller reads
        // "higher score is more relevant", the ordinary convention.
        score: -row.rank,
        ts: row.closedAt,
        cwd: row.cwd,
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
