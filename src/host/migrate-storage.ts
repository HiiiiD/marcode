import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomic } from './atomic-file';
import { TRANSCRIPT_VERSION } from './transcript-store';

export interface MigrationMarker { from: string; at: number; sessions?: number; declined?: boolean; refused?: string }
type Result = { ok: true; sessions: number } | { ok: false; reason: string };

const markerFile = (dir: string) => path.join(dir, 'migrated.json');
const exists = (p: string) => fs.access(p).then(() => true, () => false);

async function readOldIndex(dir: string): Promise<{ version: unknown; sessions: { id: string }[] } | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8')) as { version?: unknown; sessions?: unknown };
    return Array.isArray(parsed.sessions) ? { version: parsed.version, sessions: parsed.sessions as { id: string }[] } : undefined;
  } catch { return undefined; }
}

async function readSessions(dir: string): Promise<{ id: string }[] | undefined> {
  return (await readOldIndex(dir))?.sessions;
}

export async function countOldSessions(oldDir: string): Promise<number> {
  return (await readSessions(oldDir))?.length ?? 0;
}

export async function readMigrationMarker(newDir: string): Promise<MigrationMarker | undefined> {
  try { return JSON.parse(await fs.readFile(markerFile(newDir), 'utf8')) as MigrationMarker; } catch { return undefined; }
}

export async function declineMigration(newDir: string, from: string): Promise<void> {
  await writeFileAtomic(markerFile(newDir), JSON.stringify({ from, at: Date.now(), declined: true }));
}

export async function migrateStorage(oldDir: string, newDir: string, now: () => number = Date.now): Promise<Result> {
  const old = await readOldIndex(oldDir);
  if (!old) { return { ok: false, reason: `No Marcode sessions were found in ${oldDir}.` }; }
  const oldSessions = old.sessions;
  const existing = await readMigrationMarker(newDir);
  if (existing?.refused) { return { ok: false, reason: existing.refused }; }
  if (existing && !existing.declined) { return { ok: true, sessions: existing.sessions ?? oldSessions.length }; }
  if (old.version !== TRANSCRIPT_VERSION) {
    // Read as-is, another version's transcripts would be parsed as this one's shape.
    const reason = `Marcode sessions in ${oldDir} were saved at transcript version ${String(old.version)}, `
      + `and this build reads version ${TRANSCRIPT_VERSION}; they were left where they are.`;
    await writeFileAtomic(markerFile(newDir), JSON.stringify({ from: oldDir, at: now(), refused: reason }));
    return { ok: false, reason };
  }

  const created: string[] = [];
  const copyNew = async (from: string, to: string): Promise<void> => {
    if (await exists(to)) { return; }
    await fs.mkdir(path.dirname(to), { recursive: true });
    const tmp = `${to}.migrating`;
    try {
      await fs.copyFile(from, tmp);
      await fs.rename(tmp, to);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => { /* best effort */ });
      throw err;
    }
    created.push(to);
  };

  try {
    for (const name of ['catalog.json', 'usage.json', 'memory.sqlite']) {
      if (await exists(path.join(oldDir, name))) { await copyNew(path.join(oldDir, name), path.join(newDir, name)); }
    }
    const sessionsDir = path.join(oldDir, 'sessions');
    for (const name of await fs.readdir(sessionsDir).catch(() => [] as string[])) {
      if (name.endsWith('.jsonl')) { await copyNew(path.join(sessionsDir, name), path.join(newDir, 'sessions', name)); }
    }
    await mergeIndex(oldDir, newDir, created);
    await writeFileAtomic(markerFile(newDir), JSON.stringify({ from: oldDir, at: now(), sessions: oldSessions.length }));
    return { ok: true, sessions: oldSessions.length };
  } catch (err) {
    await Promise.all(created.map((f) => fs.rm(f, { force: true, recursive: true })));
    await fs.rmdir(path.join(newDir, 'sessions')).catch(() => { /* not empty or absent */ });
    return { ok: false, reason: `Importing sessions failed: ${(err as Error).message}` };
  }
}

async function mergeIndex(oldDir: string, newDir: string, created: string[]): Promise<void> {
  const target = path.join(newDir, 'index.json');
  const old = JSON.parse(await fs.readFile(path.join(oldDir, 'index.json'), 'utf8')) as { sessions: { id: string }[] };
  if (!(await exists(target))) {
    await writeFileAtomic(target, JSON.stringify(old, null, 2));
    created.push(target);
    return;
  }
  const current = JSON.parse(await fs.readFile(target, 'utf8')) as { sessions: { id: string }[] };
  const have = new Set(current.sessions.map((s) => s.id));
  const merged = { ...current, sessions: [...current.sessions, ...old.sessions.filter((s) => !have.has(s.id))] };
  await writeFileAtomic(target, JSON.stringify(merged, null, 2));
}

export type ImportResult = { kind: 'none' } | { kind: 'imported'; sessions: number } | { kind: 'failed'; reason: string };

/**
 * Runs before the host is created, so the host reads the imported roster at init and nothing
 * else is writing `index.json` in this window while the import merges into it. Never rejects.
 */
export async function importOldStorage(oldDir: string, newDir: string): Promise<ImportResult> {
  try {
    if (path.resolve(oldDir) === path.resolve(newDir)) { return { kind: 'none' }; }
    if (await readMigrationMarker(newDir)) { return { kind: 'none' }; }
    if (await countOldSessions(oldDir) === 0) { return { kind: 'none' }; }
    const result = await migrateStorage(oldDir, newDir);
    return result.ok ? { kind: 'imported', sessions: result.sessions } : { kind: 'failed', reason: result.reason };
  } catch (err) {
    return { kind: 'failed', reason: `Importing sessions failed: ${(err as Error).message}` };
  }
}
