import { existsSync } from 'node:fs';
import type { SessionId, TranscriptItem } from '../protocol/messages';
import type { MemoryPayload } from '../sync/memory-records';
import type { SessionDigest } from './digest';
import { FETCH_WINDOW, FtsMemoryStore } from './fts/fts-memory-store';
import { FtsMemoryReader } from './fts/fts-memory-reader';
import { openPlainDatabase, type SqlDb } from './sqlite-driver';
import type { MemoryDetail, MemoryHit, SearchOpts } from './types';

const ITEMS_DDL = 'CREATE TABLE IF NOT EXISTS items (sessionId TEXT PRIMARY KEY, json TEXT NOT NULL)';

/**
 * Other devices' published memory, machine-wide. Recalled only by project: rows carry a `remote:` cwd
 * that no workspace folder contains. Only the sync engine's host writes it; every other host reads.
 */
export class RemoteMemory {
  private writer: { fts: FtsMemoryStore; db: SqlDb } | undefined;
  private reader: { fts: FtsMemoryReader; db: SqlDb } | undefined;

  constructor(private readonly dbPath: string, private readonly opts: { readOnly?: boolean } = {}) {
    if (!opts.readOnly) {
      const db = openPlainDatabase(dbPath);
      db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; ${ITEMS_DDL};`);
      const fts = new FtsMemoryStore(dbPath, { tail: async (id) => ({ items: this.itemsOf(db, id), hasMore: false }) });
      this.writer = { fts, db };
    }
  }

  private itemsOf(db: SqlDb, id: SessionId): TranscriptItem[] {
    try {
      const row = db.prepare('SELECT json FROM items WHERE sessionId = ?').get(id) as { json: string } | undefined;
      return row ? JSON.parse(row.json) as TranscriptItem[] : [];
    } catch {
      return [];
    }
  }

  /** The writer, or a reader opened lazily once the writer has created the file. */
  private read(): { search: (q: string, o: SearchOpts) => Promise<MemoryHit[]>; digest: (id: SessionId) => Promise<SessionDigest | undefined>; items: (id: SessionId) => TranscriptItem[] } | undefined {
    if (this.writer) {
      const { fts, db } = this.writer;
      return { search: (q, o) => fts.search(q, o), digest: (id) => fts.getDigest(id), items: (id) => this.itemsOf(db, id) };
    }
    if (!this.reader && existsSync(this.dbPath)) {
      const fts = new FtsMemoryReader(this.dbPath);
      if (!fts.usable) { fts.close(); return undefined; }
      const db = openPlainDatabase(this.dbPath);
      db.exec('PRAGMA busy_timeout = 250;');
      this.reader = { fts, db };
    }
    if (!this.reader) { return undefined; }
    const { fts, db } = this.reader;
    return { search: async (q, o) => fts.search(q, o), digest: async (id) => fts.getDigest(id), items: (id) => this.itemsOf(db, id) };
  }

  async apply(deviceId: string, payload: MemoryPayload): Promise<void> {
    if (!this.writer) { return; }
    const { fts, db } = this.writer;
    if (payload.type === 'memory-withdraw') {
      await fts.forget(payload.sessionId);
      db.prepare('DELETE FROM items WHERE sessionId = ?').run(payload.sessionId);
      return;
    }
    db.prepare('INSERT INTO items (sessionId, json) VALUES (?, ?) ON CONFLICT(sessionId) DO UPDATE SET json = excluded.json')
      .run(payload.sessionId, JSON.stringify(payload.items));
    // One synthetic item carries the full searchable text; its id is the real first item's, so fetch anchors there.
    const anchor = payload.items[0]?.id ?? `${payload.sessionId}-text`;
    await fts.index({
      sessionId: payload.sessionId, providerId: payload.providerId, cwd: `remote:${deviceId}/${payload.relCwd}`,
      closedAt: payload.closedAt, projectId: payload.projectId, digest: payload.digest,
      items: [{ id: anchor, ts: payload.closedAt, role: 'user', text: payload.text }],
    });
  }

  async search(query: string, opts: SearchOpts): Promise<MemoryHit[]> {
    if (opts.projectId === undefined) { return []; }
    const r = this.read();
    return r ? r.search(query, { providerId: opts.providerId, limit: opts.limit, match: opts.match, projectId: opts.projectId }) : [];
  }

  async getDigest(id: SessionId): Promise<SessionDigest | undefined> {
    return this.read()?.digest(id);
  }

  async fetch(hit: { sessionId: SessionId; itemId: string }): Promise<MemoryDetail> {
    const items = this.read()?.items(hit.sessionId) ?? [];
    const at = items.findIndex((i) => i.id === hit.itemId);
    return { sessionId: hit.sessionId, items: at < 0 ? [] : items.slice(at, at + FETCH_WINDOW) };
  }

  close(): void {
    this.writer?.fts.close();
    this.writer?.db.close();
    this.reader?.fts.close();
    this.reader?.db.close();
  }
}
