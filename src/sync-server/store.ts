import { randomUUID } from 'node:crypto';
import { openPlainDatabase, type SqlDb } from '../memory/sqlite-driver';
import type { DeviceRow, ServedRecord, WireRecord } from '../sync/api-types';

export interface StoredRecord extends ServedRecord { deviceId: string; receivedAt: number }

const SCHEMA = 1;

interface DeviceDbRow {
  deviceId: string; name: string; publicKey: string; createdAt: number; lastSeenAt: number; revokedAt: number | null;
}

const toDevice = (r: DeviceDbRow): DeviceRow => ({
  deviceId: r.deviceId, name: r.name, publicKey: r.publicKey, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt,
  ...(r.revokedAt !== null ? { revokedAt: r.revokedAt } : {}),
});

/** Everything the server keeps. It holds only opaque blobs: no plaintext, key or pairing secret ever arrives. */
export class SyncStore {
  private readonly db: SqlDb;

  constructor(dbPath: string, private readonly now: () => number = Date.now) {
    this.db = openPlainDatabase(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (
        deviceId TEXT PRIMARY KEY, name TEXT NOT NULL, publicKey TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE,
        createdAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL, revokedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS pairings (
        pairingId TEXT PRIMARY KEY, byDevice TEXT NOT NULL, wrapped TEXT NOT NULL,
        expiresAt INTEGER NOT NULL, claimedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS sealed_keys (
        epoch INTEGER NOT NULL, deviceId TEXT NOT NULL, sealed TEXT NOT NULL, PRIMARY KEY (epoch, deviceId)
      );
      CREATE TABLE IF NOT EXISTS records (
        deviceId TEXT NOT NULL, seq INTEGER NOT NULL, recordId TEXT NOT NULL, epoch INTEGER NOT NULL,
        nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, receivedAt INTEGER NOT NULL,
        PRIMARY KEY (deviceId, seq), UNIQUE (deviceId, recordId)
      );
      PRAGMA user_version = ${SCHEMA};
    `);
  }

  private tx<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  setBootstrap(codeHash: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (\'bootstrap\', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(codeHash);
  }

  takeBootstrap(codeHash: string): boolean {
    return this.tx(() => {
      const enrolled = this.db.prepare('SELECT 1 AS one FROM devices LIMIT 1').get();
      const row = this.db.prepare('SELECT value FROM meta WHERE key = \'bootstrap\'').get() as { value: string } | undefined;
      if (enrolled || !row || row.value !== codeHash) { return false; }
      this.db.prepare('DELETE FROM meta WHERE key = \'bootstrap\'').run();
      return true;
    });
  }

  enrolled(): boolean {
    return this.db.prepare('SELECT 1 AS one FROM devices LIMIT 1').get() !== undefined;
  }

  addDevice(name: string, publicKey: string, tokenHash: string): DeviceRow {
    const at = this.now();
    const deviceId = randomUUID();
    this.db.prepare('INSERT INTO devices (deviceId, name, publicKey, tokenHash, createdAt, lastSeenAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(deviceId, name, publicKey, tokenHash, at, at);
    return { deviceId, name, publicKey, createdAt: at, lastSeenAt: at };
  }

  deviceByTokenHash(tokenHash: string): DeviceRow | undefined {
    const row = this.db.prepare('SELECT * FROM devices WHERE tokenHash = ? AND revokedAt IS NULL').get(tokenHash) as DeviceDbRow | undefined;
    if (!row) { return undefined; }
    const at = this.now();
    this.db.prepare('UPDATE devices SET lastSeenAt = ? WHERE deviceId = ?').run(at, row.deviceId);
    return toDevice({ ...row, lastSeenAt: at });
  }

  devices(): DeviceRow[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY createdAt').all() as DeviceDbRow[]).map(toDevice);
  }

  revoke(deviceId: string): boolean {
    const exists = this.db.prepare('SELECT 1 AS one FROM devices WHERE deviceId = ? AND revokedAt IS NULL').get(deviceId);
    if (!exists) { return false; }
    this.db.prepare('UPDATE devices SET revokedAt = ? WHERE deviceId = ?').run(this.now(), deviceId);
    return true;
  }

  createPairing(pairingId: string, by: string, wrapped: string, expiresAt: number): void {
    this.db.prepare('INSERT INTO pairings (pairingId, byDevice, wrapped, expiresAt) VALUES (?, ?, ?, ?)')
      .run(pairingId, by, wrapped, expiresAt);
  }

  claimPairing(pairingId: string): { wrapped: string } | 'gone' {
    return this.tx(() => {
      const row = this.db.prepare('SELECT wrapped, expiresAt, claimedAt FROM pairings WHERE pairingId = ?').get(pairingId) as
        { wrapped: string; expiresAt: number; claimedAt: number | null } | undefined;
      if (!row || row.claimedAt !== null || row.expiresAt < this.now()) { return 'gone' as const; }
      this.db.prepare('UPDATE pairings SET claimedAt = ? WHERE pairingId = ?').run(this.now(), pairingId);
      return { wrapped: row.wrapped };
    });
  }

  createEpoch(epoch: number, sealedByDevice: Record<string, string>): boolean {
    return this.tx(() => {
      if (this.db.prepare('SELECT 1 AS one FROM sealed_keys WHERE epoch = ? LIMIT 1').get(epoch)) { return false; }
      this.insertSealed(epoch, sealedByDevice);
      return true;
    });
  }

  addSealed(epoch: number, sealedByDevice: Record<string, string>): void {
    this.tx(() => { this.insertSealed(epoch, sealedByDevice); });
  }

  private insertSealed(epoch: number, sealedByDevice: Record<string, string>): void {
    for (const [deviceId, sealed] of Object.entries(sealedByDevice)) {
      this.db.prepare('INSERT OR IGNORE INTO sealed_keys (epoch, deviceId, sealed) VALUES (?, ?, ?)').run(epoch, deviceId, sealed);
    }
  }

  keysFor(deviceId: string): Array<{ epoch: number; sealed: string }> {
    return (this.db.prepare('SELECT epoch, sealed FROM sealed_keys WHERE deviceId = ? ORDER BY epoch').all(deviceId) as
      Array<{ epoch: number; sealed: string }>).map((r) => ({ epoch: r.epoch, sealed: r.sealed }));
  }

  holders(): Array<{ epoch: number; deviceIds: string[] }> {
    const rows = this.db.prepare('SELECT epoch, deviceId FROM sealed_keys ORDER BY epoch, deviceId').all() as
      Array<{ epoch: number; deviceId: string }>;
    const byEpoch = new Map<number, string[]>();
    for (const r of rows) { byEpoch.set(r.epoch, [...(byEpoch.get(r.epoch) ?? []), r.deviceId]); }
    return [...byEpoch].map(([epoch, deviceIds]) => ({ epoch, deviceIds }));
  }

  append(deviceId: string, records: WireRecord[]): Array<{ recordId: string; seq: number }> {
    return this.tx(() => {
      const head = this.db.prepare('SELECT MAX(seq) AS last FROM records WHERE deviceId = ?').get(deviceId) as { last: number | null };
      let last = head.last ?? 0;
      const at = this.now();
      return records.map((r) => {
        const existing = this.db.prepare('SELECT seq FROM records WHERE deviceId = ? AND recordId = ?').get(deviceId, r.recordId) as
          { seq: number } | undefined;
        if (existing) { return { recordId: r.recordId, seq: existing.seq }; }
        last++;
        this.db.prepare(`INSERT INTO records (deviceId, seq, recordId, epoch, nonce, ciphertext, receivedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(deviceId, last, r.recordId, r.epoch, r.nonce, r.ciphertext, at);
        return { recordId: r.recordId, seq: last };
      });
    });
  }

  streams(): Array<{ deviceId: string; lastSeq: number }> {
    return (this.db.prepare('SELECT deviceId, MAX(seq) AS lastSeq FROM records GROUP BY deviceId ORDER BY deviceId').all() as
      Array<{ deviceId: string; lastSeq: number }>).map((r) => ({ deviceId: r.deviceId, lastSeq: r.lastSeq }));
  }

  read(deviceId: string, afterSeq: number, limit: number): StoredRecord[] {
    return (this.db.prepare(`SELECT deviceId, seq, recordId, epoch, nonce, ciphertext, receivedAt FROM records
      WHERE deviceId = ? AND seq > ? ORDER BY seq LIMIT ?`).all(deviceId, afterSeq, limit) as StoredRecord[])
      .map((r) => ({ ...r }));
  }

  close(): void {
    this.db.close();
  }
}
