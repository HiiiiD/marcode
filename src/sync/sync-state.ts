import { randomBytes } from 'node:crypto';
import type { DigestMeta } from '../memory/types';
import { openPlainDatabase, type SqlDb } from '../memory/sqlite-driver';

type PublishedKey = Pick<DigestMeta, 'forUpdatedAt' | 'source' | 'summarizerVersion'>;
const keyOf = (d: PublishedKey): string => `${d.forUpdatedAt}:${d.source}:${d.summarizerVersion}`;

/** Machine-wide sync bookkeeping. A cache: losing it costs a re-pull or a re-publish, never data. */
export class SyncState {
  private readonly db: SqlDb;

  constructor(dbPath: string) {
    this.db = openPlainDatabase(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS outbox (n INTEGER PRIMARY KEY AUTOINCREMENT, recordId TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS published (sessionId TEXT PRIMARY KEY, digestKey TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (deviceId TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS held_epoch (sessionId TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS last_checkout (projectId TEXT PRIMARY KEY, root TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_pub (sessionId TEXT NOT NULL, name TEXT NOT NULL, generation INTEGER NOT NULL, offset INTEGER NOT NULL, PRIMARY KEY (sessionId, name));
      CREATE TABLE IF NOT EXISTS session_pub (sessionId TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 0, fingerprint TEXT, backfilled INTEGER NOT NULL DEFAULT 0);
    `);
  }

  enqueue(payload: unknown): string {
    const recordId = randomBytes(16).toString('hex');
    this.db.prepare('INSERT INTO outbox (recordId, payload, createdAt) VALUES (?, ?, ?)').run(recordId, JSON.stringify(payload), Date.now());
    return recordId;
  }

  peek(limit: number): Array<{ recordId: string; payload: unknown }> {
    return (this.db.prepare('SELECT recordId, payload FROM outbox ORDER BY n LIMIT ?').all(limit) as Array<{ recordId: string; payload: string }>)
      .map((r) => ({ recordId: r.recordId, payload: JSON.parse(r.payload) as unknown }));
  }

  remove(recordIds: string[]): void {
    for (const id of recordIds) { this.db.prepare('DELETE FROM outbox WHERE recordId = ?').run(id); }
  }

  outboxSize(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n;
  }

  wasPublished(sessionId: string, digest: PublishedKey): boolean {
    const row = this.db.prepare('SELECT digestKey FROM published WHERE sessionId = ?').get(sessionId) as { digestKey: string } | undefined;
    return row?.digestKey === keyOf(digest);
  }

  markPublished(sessionId: string, digest: PublishedKey): void {
    this.db.prepare('INSERT INTO published (sessionId, digestKey) VALUES (?, ?) ON CONFLICT(sessionId) DO UPDATE SET digestKey = excluded.digestKey')
      .run(sessionId, keyOf(digest));
  }

  clearPublished(sessionId: string): void {
    this.db.prepare('DELETE FROM published WHERE sessionId = ?').run(sessionId);
  }

  cursor(deviceId: string): number {
    return (this.db.prepare('SELECT seq FROM cursors WHERE deviceId = ?').get(deviceId) as { seq: number } | undefined)?.seq ?? 0;
  }

  setCursor(deviceId: string, seq: number): void {
    this.db.prepare('INSERT INTO cursors (deviceId, seq) VALUES (?, ?) ON CONFLICT(deviceId) DO UPDATE SET seq = MAX(seq, excluded.seq)').run(deviceId, seq);
  }

  /** Reserves `count` consecutive revs for a session's ops records and returns the first. */
  nextRevs(sessionId: string, count: number): number {
    this.db.prepare('INSERT INTO session_pub (sessionId, rev) VALUES (?, ?) ON CONFLICT(sessionId) DO UPDATE SET rev = rev + excluded.rev')
      .run(sessionId, count);
    return (this.db.prepare('SELECT rev FROM session_pub WHERE sessionId = ?').get(sessionId) as { rev: number }).rev - count + 1;
  }

  /** The last ops rev reserved for a session; 0 when none went out. */
  publishedRev(sessionId: string): number {
    return (this.db.prepare('SELECT rev FROM session_pub WHERE sessionId = ?').get(sessionId) as { rev: number } | undefined)?.rev ?? 0;
  }

  metaFingerprint(sessionId: string): string | undefined {
    const row = this.db.prepare('SELECT fingerprint FROM session_pub WHERE sessionId = ?').get(sessionId) as { fingerprint: string | null } | undefined;
    return row?.fingerprint ?? undefined;
  }

  setMetaFingerprint(sessionId: string, fingerprint: string): void {
    this.db.prepare('INSERT INTO session_pub (sessionId, fingerprint) VALUES (?, ?) ON CONFLICT(sessionId) DO UPDATE SET fingerprint = excluded.fingerprint')
      .run(sessionId, fingerprint);
  }

  wasBackfilled(sessionId: string): boolean {
    return (this.db.prepare('SELECT backfilled FROM session_pub WHERE sessionId = ?').get(sessionId) as { backfilled: number } | undefined)?.backfilled === 1;
  }

  markBackfilled(sessionId: string): void {
    this.db.prepare('INSERT INTO session_pub (sessionId, backfilled) VALUES (?, 1) ON CONFLICT(sessionId) DO UPDATE SET backfilled = 1').run(sessionId);
  }

  /** Whether anything of this session ever went out, so a delete knows to send a tombstone. */
  wasSessionPublished(sessionId: string): boolean {
    return this.db.prepare('SELECT 1 AS x FROM session_pub WHERE sessionId = ?').get(sessionId) !== undefined;
  }

  forgetSession(sessionId: string): void {
    this.db.prepare('DELETE FROM session_pub WHERE sessionId = ?').run(sessionId);
  }

  /** How much of a session's native-thread file has gone up, and in which generation. */
  threadOffset(sessionId: string, name: string): { generation: number; offset: number } | undefined {
    return this.db.prepare('SELECT generation, offset FROM thread_pub WHERE sessionId = ? AND name = ?').get(sessionId, name) as { generation: number; offset: number } | undefined;
  }

  setThreadOffset(sessionId: string, name: string, at: { generation: number; offset: number }): void {
    this.db.prepare('INSERT INTO thread_pub (sessionId, name, generation, offset) VALUES (?, ?, ?, ?) ON CONFLICT(sessionId, name) DO UPDATE SET generation = excluded.generation, offset = excluded.offset')
      .run(sessionId, name, at.generation, at.offset);
  }

  /** Ops of this session still waiting to go up. */
  hasOutboxOps(sessionId: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM outbox WHERE json_extract(payload, '$.sessionId') = ? AND json_extract(payload, '$.type') = 'session-ops' LIMIT 1")
      .get(sessionId) !== undefined;
  }

  /** Forgets everything queued for a session another device now owns: sending it would write over that device's copy. */
  dropSessionOutbox(sessionId: string): void {
    this.db.prepare("DELETE FROM outbox WHERE json_extract(payload, '$.sessionId') = ?").run(sessionId);
  }

  /** The owner-record epoch this device won for a session; 0 when it never claimed one (it published it first). */
  heldEpoch(sessionId: string): number {
    return (this.db.prepare('SELECT epoch FROM held_epoch WHERE sessionId = ?').get(sessionId) as { epoch: number } | undefined)?.epoch ?? 0;
  }

  setHeldEpoch(sessionId: string, epoch: number): void {
    this.db.prepare('INSERT INTO held_epoch (sessionId, epoch) VALUES (?, ?) ON CONFLICT(sessionId) DO UPDATE SET epoch = MAX(epoch, excluded.epoch)').run(sessionId, epoch);
  }

  lastCheckout(projectId: string): string | undefined {
    return (this.db.prepare('SELECT root FROM last_checkout WHERE projectId = ?').get(projectId) as { root: string } | undefined)?.root;
  }

  setLastCheckout(projectId: string, root: string): void {
    this.db.prepare('INSERT INTO last_checkout (projectId, root) VALUES (?, ?) ON CONFLICT(projectId) DO UPDATE SET root = excluded.root').run(projectId, root);
  }

  close(): void {
    this.db.close();
  }
}
