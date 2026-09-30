import * as fs from 'node:fs/promises';
import type { SessionId, TranscriptPatch } from '../protocol/messages';
import type { TranscriptStore } from './transcript-store';

interface Options {
  id: SessionId;
  file: string;
  store: TranscriptStore;
  stillForeign: () => Promise<boolean>;
  onPatch: (patch: TranscriptPatch) => void;
  onFree: () => void;
  intervalMs?: number;
}

/**
 * Polls instead of `fs.watch`: watch events are unreliable on network shares
 * and coalesce differently per OS, and the owner only flushes at turn end and
 * every 500 ms anyway. A whole-file reload diffed by item id is used because
 * the owner rewrites the file (atomically) on a `replace`, so an offset read
 * would miss it.
 */
export class ForeignTail {
  private timer?: NodeJS.Timeout;
  private signature = '';
  private busy = false;

  constructor(private readonly o: Options) {}

  start(): void {
    if (this.timer) { return; }
    this.timer = setInterval(() => { void this.tick(); }, this.o.intervalMs ?? 750);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  private async tick(): Promise<void> {
    if (this.busy) { return; }
    this.busy = true;
    try {
      if (!(await this.o.stillForeign())) {
        this.stop();
        this.o.onFree();
        return;
      }
      const stat = await fs.stat(this.o.file).catch(() => undefined);
      const signature = stat ? `${stat.size}:${stat.mtimeMs}` : '';
      if (signature === this.signature) { return; }
      this.signature = signature;
      const { appended, replaced } = await this.o.store.reloadFromDisk(this.o.id);
      for (const item of replaced) { this.o.onPatch({ op: 'replace', item }); }
      for (const item of appended) { this.o.onPatch({ op: 'append', item }); }
    } catch {
      // Errors are state: a failed poll is retried on the next tick.
    } finally {
      this.busy = false;
    }
  }
}
