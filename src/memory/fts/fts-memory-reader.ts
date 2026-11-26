import type { SessionId } from '../../protocol/messages';
import type { SessionDigest } from '../digest';
import { openDatabase, type SqlDb } from '../sqlite-driver';
import type { MemoryHit, SearchOpts } from '../types';
import { hasProjectColumn, searchRows } from './fts-search';

/** What `ProjectMemory` needs from a sibling workspace's database. */
export interface SiblingReader {
  readonly usable: boolean;
  search(query: string, opts: SearchOpts): MemoryHit[];
  getDigest(id: SessionId): SessionDigest | undefined;
  close(): void;
}

/**
 * Another host's `memory.sqlite`, opened only to read: no DDL, no writes, and a short busy
 * timeout so a sibling mid-write costs recall a fraction of a second, never the writer's 5 s.
 */
export class FtsMemoryReader implements SiblingReader {
  private readonly db: SqlDb | undefined;
  readonly usable: boolean;

  constructor(dbPath: string) {
    let db: SqlDb | undefined;
    let usable = false;
    try {
      db = openDatabase(dbPath);
      db.exec('PRAGMA busy_timeout = 250;');
      usable = hasProjectColumn(db);
    } catch {
      usable = false;
    }
    this.db = db;
    this.usable = usable;
  }

  search(query: string, opts: SearchOpts): MemoryHit[] {
    if (!this.usable || !this.db) { return []; }
    return searchRows(this.db, query, opts);
  }

  getDigest(id: SessionId): SessionDigest | undefined {
    if (!this.usable || !this.db) { return undefined; }
    try {
      const row = this.db.prepare('SELECT json FROM digests WHERE sessionId = ?').get(id) as { json: string } | undefined;
      return row ? JSON.parse(row.json) as SessionDigest : undefined;
    } catch {
      return undefined;
    }
  }

  close(): void {
    try { this.db?.close(); } catch { /* already gone */ }
  }
}
