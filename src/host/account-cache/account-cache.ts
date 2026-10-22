import { openPlainDatabase, type SqlDb } from '../../memory/sqlite-driver';
import type { ModelInfo, UsageWindow } from '../../providers/types';
import { validModels, validWindows } from './validate';

export const ACCOUNT_CACHE_SCHEMA = 1;

export interface UsageRow { instance: string; windows: UsageWindow[] | null; fetchedAt: number }
export interface CatalogRow { instance: string; models: ModelInfo[]; fetchedAt: number }

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS usage(instance TEXT PRIMARY KEY, windows_json TEXT, fetched_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS catalog(instance TEXT PRIMARY KEY, models_json TEXT NOT NULL, fetched_at INTEGER NOT NULL);
`;

/**
 * Machine-wide plan usage and model-catalog seed, shared by every host process.
 * Never throws: an unopenable, corrupt or newer-schema file yields an inert instance.
 */
export class AccountCache {
  private lastDataVersion: number | undefined;

  private constructor(private db: SqlDb | undefined) {}

  static open(dbPath: string, opts: { busyTimeoutMs?: number } = {}): AccountCache {
    let db: SqlDb | undefined;
    try {
      db = openPlainDatabase(dbPath);
      db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 5000};`);
      const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version > ACCOUNT_CACHE_SCHEMA) {
        db.close();
        return new AccountCache(undefined);
      }
      // WAL only lets readers run beside a writer; a host that could not switch (another one mid-write) still works.
      try { db.exec('PRAGMA journal_mode = WAL;'); } catch (err) {
        console.warn('[mar-code] account-cache: could not switch to WAL, continuing without it', err);
      }
      if (version === 0) {
        db.exec(SCHEMA_SQL);
        db.exec(`PRAGMA user_version = ${ACCOUNT_CACHE_SCHEMA};`);
      }
      return new AccountCache(db);
    } catch (err) {
      console.warn('[mar-code] account-cache: could not open, plan usage will not be shared', err);
      try { db?.close(); } catch { /* already unusable */ }
      return new AccountCache(undefined);
    }
  }

  get available(): boolean { return this.db !== undefined; }

  isEmpty(): boolean {
    const db = this.db;
    if (!db) { return true; }
    try {
      return db.prepare('SELECT 1 FROM usage UNION ALL SELECT 1 FROM catalog LIMIT 1').get() === undefined;
    } catch {
      return true;
    }
  }

  readUsage(): UsageRow[] {
    const rows = this.select<{ instance: string; windows_json: string | null; fetched_at: number }>(
      'SELECT instance, windows_json, fetched_at FROM usage',
    );
    const out: UsageRow[] = [];
    for (const r of rows) {
      if (r.windows_json === null) {
        out.push({ instance: r.instance, windows: null, fetchedAt: r.fetched_at });
        continue;
      }
      const windows = validWindows(parseJson(r.windows_json));
      if (windows) { out.push({ instance: r.instance, windows, fetchedAt: r.fetched_at }); }
    }
    return out;
  }

  readCatalog(): CatalogRow[] {
    const rows = this.select<{ instance: string; models_json: string; fetched_at: number }>(
      'SELECT instance, models_json, fetched_at FROM catalog',
    );
    const out: CatalogRow[] = [];
    for (const r of rows) {
      const models = validModels(parseJson(r.models_json));
      if (models.length > 0) { out.push({ instance: r.instance, models, fetchedAt: r.fetched_at }); }
    }
    return out;
  }

  writeUsage(row: UsageRow): void {
    this.run(
      `INSERT INTO usage(instance, windows_json, fetched_at) VALUES(?, ?, ?)
       ON CONFLICT(instance) DO UPDATE SET windows_json = excluded.windows_json, fetched_at = excluded.fetched_at
       WHERE excluded.fetched_at > usage.fetched_at`,
      row.instance, row.windows === null ? null : JSON.stringify(row.windows), row.fetchedAt,
    );
  }

  writeCatalog(row: CatalogRow): void {
    if (row.models.length === 0) { return; }
    this.run(
      `INSERT INTO catalog(instance, models_json, fetched_at) VALUES(?, ?, ?)
       ON CONFLICT(instance) DO UPDATE SET models_json = excluded.models_json, fetched_at = excluded.fetched_at
       WHERE excluded.fetched_at > catalog.fetched_at`,
      row.instance, JSON.stringify(row.models), row.fetchedAt,
    );
  }

  // data_version moves only when another connection commits, so our own writes never read as a change
  hasChanged(): boolean {
    const db = this.db;
    if (!db) { return false; }
    try {
      const { data_version: current } = db.prepare('PRAGMA data_version').get() as { data_version: number };
      const previous = this.lastDataVersion;
      this.lastDataVersion = current;
      return previous !== undefined && previous !== current;
    } catch {
      return false;
    }
  }

  close(): void {
    const db = this.db;
    this.db = undefined;
    try { db?.close(); } catch { /* nothing left to release */ }
  }

  private select<T>(sql: string): T[] {
    try {
      return (this.db?.prepare(sql).all() as T[] | undefined) ?? [];
    } catch {
      return [];
    }
  }

  private run(sql: string, ...params: unknown[]): void {
    try { this.db?.prepare(sql).run(...params); } catch (err) {
      console.warn('[mar-code] account-cache: write dropped', err);
    }
  }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}
