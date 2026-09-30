import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomic } from './atomic-file';

export interface MigrationMarker { from: string; at: number; sessions?: number; declined?: boolean }
type Result = { ok: true; sessions: number } | { ok: false; reason: string };

const markerFile = (dir: string) => path.join(dir, 'migrated.json');
const exists = (p: string) => fs.access(p).then(() => true, () => false);

async function readSessions(dir: string): Promise<{ id: string }[] | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8')) as { sessions?: unknown };
    return Array.isArray(parsed.sessions) ? (parsed.sessions as { id: string }[]) : undefined;
  } catch { return undefined; }
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
  const oldSessions = await readSessions(oldDir);
  if (!oldSessions) { return { ok: false, reason: `No Marcode sessions were found in ${oldDir}.` }; }
  const existing = await readMigrationMarker(newDir);
  if (existing && !existing.declined) { return { ok: true, sessions: existing.sessions ?? oldSessions.length }; }

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
