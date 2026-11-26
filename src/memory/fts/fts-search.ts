import type { SqlDb } from '../sqlite-driver';
import { isWithin } from '../../shared/path-scope';
import type { MemoryHit, SearchOpts } from '../types';

const SCOPED_FETCH = 500;

export function hasProjectColumn(db: SqlDb): boolean {
  const cols = db.prepare('PRAGMA table_info(digests)').all() as Array<{ name: string }>;
  return cols.some((c) => c.name === 'projectId');
}

/**
 * FTS5's `MATCH` grammar runs before tokenization, so punctuation a caller never meant
 * (`?`, `:`, `/`, `-`, an empty string) is a syntax error rather than "no results". Every query
 * is reduced to double-quoted barewords; any remaining SQL error (a corrupt index) yields [].
 */
export function searchRows(db: SqlDb, query: string, opts: SearchOpts = {}): MemoryHit[] {
  const limit = opts.limit ?? 20;
  const scoped = opts.cwdWithin !== undefined || opts.projectId !== undefined;
  // The scope filter runs in JS (path comparison is platform-dependent), so over-fetch to still fill `limit`.
  const fetchLimit = scoped ? Math.max(limit, SCOPED_FETCH) : limit;
  const providerId = opts.providerId ?? null;
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (terms.length === 0) { return []; }
  const match = terms.map((term) => `"${term}"`).join(opts.match === 'any' ? ' OR ' : ' ');
  try {
    const rows = db.prepare(`
      SELECT f.sessionId AS sessionId, f.firstItemId AS firstItemId, f.summary AS summary,
        f.closedAt AS closedAt, f.cwd AS cwd, d.projectId AS projectId, bm25(sessions_fts) AS rank
      FROM sessions_fts f
      LEFT JOIN digests d ON d.sessionId = f.sessionId
      WHERE sessions_fts MATCH ?
        AND (? IS NULL OR f.providerId = ?)
      ORDER BY rank
      LIMIT ?
    `).all(match, providerId, providerId, fetchLimit) as Array<{
      sessionId: string; firstItemId: string; summary: string; closedAt: number;
      cwd: string; projectId: string | null; rank: number;
    }>;
    const inScope = scoped
      ? rows.filter((row) => (opts.cwdWithin !== undefined && isWithin(opts.cwdWithin, row.cwd))
        || (opts.projectId !== undefined && row.projectId === opts.projectId))
      : rows;
    return inScope.slice(0, limit).map((row) => ({
      sessionId: row.sessionId,
      itemId: row.firstItemId,
      snippet: row.summary,
      // bm25() is negative and lower-is-better; flipped so a caller reads "higher is more relevant".
      score: -row.rank,
      ts: row.closedAt,
      cwd: row.cwd,
      ...(row.projectId ? { projectId: row.projectId } : {}),
    }));
  } catch (err) {
    console.error('[mar-code] memory search failed', err);
    return [];
  }
}
