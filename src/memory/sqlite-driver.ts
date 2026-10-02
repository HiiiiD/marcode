export interface SqlStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): void;
}

export interface SqlDb {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

export interface RawDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  close(): void;
}

export function wrapDatabase(raw: RawDatabase): SqlDb {
  return {
    exec: (sql) => { raw.exec(sql); },
    prepare: (sql) => {
      const statement = raw.prepare(sql);
      return {
        // bun:sqlite reports no row as null, node:sqlite as undefined
        get: (...params) => statement.get(...params) ?? undefined,
        all: (...params) => statement.all(...params),
        run: (...params) => { statement.run(...params); },
      };
    },
    close: () => raw.close(),
  };
}

// A build without FTS5 (the macOS system SQLite is the known risk) must fail here, not on the first query.
export function assertFts5(db: SqlDb): void {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x); DROP TABLE temp.fts5_probe;');
  } catch (err) {
    throw new Error(`SQLite FTS5 is unavailable: ${(err as Error).message}`);
  }
}

// require, not a top-level import: the module that does not exist on this runtime must only fail when opened.
function openRaw(dbPath: string): RawDatabase {
  if (process.versions.bun) {
    const { Database } = require('bun:sqlite') as { Database: new (file: string) => RawDatabase };
    return new Database(dbPath);
  }
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string) => RawDatabase };
  return new DatabaseSync(dbPath);
}

export function openDatabase(dbPath: string): SqlDb {
  const db = wrapDatabase(openRaw(dbPath));
  try {
    assertFts5(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
