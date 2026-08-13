import * as fs from 'fs/promises';
import * as path from 'path';
import type { PaneLayout, SessionId, SessionState, TranscriptItem } from '../protocol/messages';

export interface StoredIndex {
  sessions: SessionState[];
  layout: PaneLayout;
}

const EMPTY_INDEX: StoredIndex = {
  sessions: [],
  layout: { orientation: 'vertical', panes: [] },
};

export class TranscriptStore {
  private cache = new Map<SessionId, TranscriptItem[]>();
  private pending = new Map<SessionId, TranscriptItem[]>();
  private dirty = new Set<SessionId>();
  private replacements = new Map<SessionId, Map<string, TranscriptItem>>();
  /**
   * flush() reads a session's pending/dirty queues and only clears them
   * after the write completes. Two overlapping flush() calls for the same
   * session id — one from a caller that flushes a single id, another from a
   * caller that flushes "all pending ids" — can both observe the same
   * pending queue before either clears it, duplicating writes on disk (the
   * append-only path appends the same queued items twice). remove() has the
   * same hazard from the other direction: it deletes the on-disk file
   * directly, so a flush() already mid-flight for that id can finish its
   * fs.appendFile *after* remove() has run, recreating the file the caller
   * asked to delete. Both flush() and remove() route through `serialize()`
   * for a given session id so they always run strictly one-at-a-time
   * regardless of which caller or call shape triggered them.
   */
  private chains = new Map<SessionId, Promise<void>>();

  constructor(private readonly rootDir: string) {}

  private sessionFile(id: SessionId): string {
    return path.join(this.rootDir, 'sessions', `${id}.jsonl`);
  }

  private async ensureLoaded(id: SessionId): Promise<TranscriptItem[]> {
    const cached = this.cache.get(id);
    if (cached) { return cached; }

    let items: TranscriptItem[] = [];
    try {
      const raw = await fs.readFile(this.sessionFile(id), 'utf8');
      items = raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as TranscriptItem);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
    }
    const reps = this.replacements.get(id);
    if (reps) {
      items = items.map((i) => reps.get(i.id) ?? i);
    }
    this.cache.set(id, items);
    return items;
  }

  append(id: SessionId, item: TranscriptItem): void {
    const cached = this.cache.get(id);
    if (cached) { cached.push(item); }
    const queue = this.pending.get(id) ?? [];
    queue.push(item);
    this.pending.set(id, queue);
  }

  replace(id: SessionId, item: TranscriptItem): void {
    const cached = this.cache.get(id);
    if (cached) {
      const at = cached.findIndex((i) => i.id === item.id);
      if (at >= 0) { cached[at] = item; } else { cached.push(item); }
    }
    const queue = this.pending.get(id);
    if (queue) {
      const at = queue.findIndex((i) => i.id === item.id);
      if (at >= 0) { queue[at] = item; return; }
    }
    const map = this.replacements.get(id) ?? new Map<string, TranscriptItem>();
    map.set(item.id, item);
    this.replacements.set(id, map);
    this.dirty.add(id);
  }

  async flush(id?: SessionId): Promise<void> {
    const ids = id ? [id] : [...new Set([...this.pending.keys(), ...this.dirty])];
    await fs.mkdir(path.join(this.rootDir, 'sessions'), { recursive: true });
    await Promise.all(
      ids.map((sessionId) => this.serialize(sessionId, () => this.flushOne(sessionId))),
    );
  }

  /**
   * Chains `work` onto any in-flight flush/remove for this id so callers
   * never overlap, regardless of which operation they are.
   */
  private serialize(sessionId: SessionId, work: () => Promise<void>): Promise<void> {
    const prior = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prior.then(work, work);
    // Store a variant that never rejects, so a failed link doesn't wedge the
    // chain for the next caller (who still needs to run) or surface as an
    // unhandled rejection when nobody is awaiting this particular link.
    this.chains.set(sessionId, next.catch(() => { /* see chain doc above */ }));
    return next;
  }

  private async flushOne(sessionId: SessionId): Promise<void> {
    if (this.dirty.has(sessionId)) {
      const items = await this.ensureLoaded(sessionId);
      const queued = this.pending.get(sessionId) ?? [];
      for (const q of queued) {
        if (!items.some((i) => i.id === q.id)) { items.push(q); }
      }
      const body = items.map((i) => JSON.stringify(i)).join('\n');
      await fs.writeFile(this.sessionFile(sessionId), body ? `${body}\n` : '', 'utf8');
      this.dirty.delete(sessionId);
      this.pending.delete(sessionId);
      this.replacements.delete(sessionId);
      return;
    }

    const queued = this.pending.get(sessionId);
    if (!queued || queued.length === 0) { return; }
    const body = queued.map((i) => JSON.stringify(i)).join('\n');
    await fs.appendFile(this.sessionFile(sessionId), `${body}\n`, 'utf8');
    this.pending.delete(sessionId);
  }

  async tail(
    id: SessionId,
    limit = 100,
  ): Promise<{ items: TranscriptItem[]; hasMore: boolean }> {
    const items = await this.ensureLoaded(id);
    const start = Math.max(0, items.length - limit);
    return { items: items.slice(start), hasMore: start > 0 };
  }

  async before(
    id: SessionId,
    beforeItemId: string,
    limit = 100,
  ): Promise<{ items: TranscriptItem[]; hasMore: boolean }> {
    const items = await this.ensureLoaded(id);
    const at = items.findIndex((i) => i.id === beforeItemId);
    if (at <= 0) { return { items: [], hasMore: false }; }
    const start = Math.max(0, at - limit);
    return { items: items.slice(start, at), hasMore: start > 0 };
  }

  async remove(id: SessionId): Promise<void> {
    await this.serialize(id, async () => {
      this.cache.delete(id);
      this.pending.delete(id);
      this.dirty.delete(id);
      this.replacements.delete(id);
      await fs.rm(this.sessionFile(id), { force: true });
    });
    // Drop the chain entry now that removal has actually run: nothing is
    // pending for this id anymore, so there is nothing left to serialize
    // against, and a later flush()/remove() for a reused id starts clean.
    this.chains.delete(id);
  }

  async readIndex(): Promise<StoredIndex> {
    try {
      const raw = await fs.readFile(path.join(this.rootDir, 'index.json'), 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredIndex>;
      return {
        sessions: parsed.sessions ?? [],
        layout: parsed.layout ?? EMPTY_INDEX.layout,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return { ...EMPTY_INDEX }; }
      throw err;
    }
  }

  async writeIndex(index: StoredIndex): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(
      path.join(this.rootDir, 'index.json'),
      JSON.stringify(index, null, 2),
      'utf8',
    );
  }
}
