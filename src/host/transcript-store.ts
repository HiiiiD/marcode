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
    let skipped = 0;
    try {
      const raw = await fs.readFile(this.sessionFile(id), 'utf8');
      for (const line of raw.split('\n')) {
        if (line.trim().length === 0) { continue; }
        try {
          items.push(JSON.parse(line) as TranscriptItem);
        } catch {
          // A truncated or otherwise unparseable line — what a process kill
          // during a write leaves behind. Throwing here escapes tail()/
          // before()/flushOne() and, since MessageRouter only logs, leaves
          // the pane permanently blank with no error state, violating
          // "errors are state, never exceptions". A partial transcript beats
          // no transcript: skip the line and surface it below instead.
          skipped++;
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
    }
    if (skipped > 0) {
      // Make the loss visible in the transcript rather than silently short.
      // A stable id keeps a rewrite from stacking duplicates.
      items.push({
        id: `corrupt-${id}`,
        ts: Date.now(),
        role: 'error',
        message: `${skipped} unreadable transcript ${skipped === 1 ? 'line was' : 'lines were'} skipped (the file was damaged, most likely by an interrupted write).`,
      });
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

  /**
   * Writes `body` to `file` atomically: a partial or failed write lands on a
   * temp file and the destination is only ever swapped in whole, by rename.
   * The previous non-atomic truncate-then-write left a half-written JSONL
   * file behind whenever the process died mid-write.
   */
  private async writeAtomic(file: string, body: string): Promise<void> {
    const tmp = `${file}.tmp`;
    try {
      await fs.writeFile(tmp, body, 'utf8');
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => { /* best effort cleanup */ });
      throw err;
    }
  }

  /**
   * Puts `queued` back at the *front* of the pending queue after a failed
   * write, ahead of anything appended while that write was in flight, so
   * transcript order survives the retry.
   */
  private requeue(sessionId: SessionId, queued: TranscriptItem[]): void {
    if (queued.length === 0) { return; }
    const since = this.pending.get(sessionId);
    this.pending.set(sessionId, since ? [...queued, ...since] : queued);
  }

  /**
   * IMPORTANT: everything this method takes out of `pending`/`dirty`/
   * `replacements` is taken *before* the write's first await, and put back
   * only if that write fails. append()/replace() are synchronous calls made
   * by AgentSession's event pump and can land at any await point here; the
   * per-id `serialize()` chain orders flush-vs-flush and flush-vs-remove but
   * has no bearing on them. Clearing the queues *after* the await (as this
   * used to) discards every item that arrived during it — it was never in
   * `body`, and its queue entry and dirty flag are wiped, so no later flush
   * recovers it. Taking the queues up front means such an item lands in a
   * fresh queue that the next flush writes.
   */
  private async flushOne(sessionId: SessionId): Promise<void> {
    if (this.dirty.has(sessionId)) {
      // ensureLoaded() awaits, but anything appended/replaced during it is
      // still in the queues we take below (append() only touches
      // pending/cache; replace() lands in `replacements`, which
      // ensureLoaded() itself applies to the items it returns).
      const items = await this.ensureLoaded(sessionId);

      // --- no awaits from here to the write ---
      const queued = this.pending.get(sessionId) ?? [];
      const reps = this.replacements.get(sessionId);
      this.pending.delete(sessionId);
      this.replacements.delete(sessionId);
      this.dirty.delete(sessionId);
      for (const q of queued) {
        if (!items.some((i) => i.id === q.id)) { items.push(q); }
      }
      const body = items.map((i) => JSON.stringify(i)).join('\n');
      // --- ---

      try {
        await this.writeAtomic(this.sessionFile(sessionId), body ? `${body}\n` : '');
      } catch (err) {
        // Nothing reached disk (writeAtomic is all-or-nothing), so restore
        // what we took. Merging *under* anything recorded since keeps the
        // newer replacement of the same item id winning.
        this.requeue(sessionId, queued);
        if (reps) {
          for (const [key, value] of this.replacements.get(sessionId) ?? []) {
            reps.set(key, value);
          }
          this.replacements.set(sessionId, reps);
        }
        this.dirty.add(sessionId);
        throw err;
      }
      return;
    }

    const queued = this.pending.get(sessionId);
    if (!queued || queued.length === 0) { return; }
    this.pending.delete(sessionId);
    const body = queued.map((i) => JSON.stringify(i)).join('\n');
    try {
      await fs.appendFile(this.sessionFile(sessionId), `${body}\n`, 'utf8');
    } catch (err) {
      // A failed append may still have written part of `body`; re-queueing
      // risks a duplicated prefix, but losing the items outright is worse
      // and the dedupe in the dirty path above bounds the damage.
      this.requeue(sessionId, queued);
      throw err;
    }
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
      // A crash between writeAtomic()'s writeFile and its rename can leave
      // this behind; don't let it outlive the session it belonged to.
      await fs.rm(`${this.sessionFile(id)}.tmp`, { force: true });
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
