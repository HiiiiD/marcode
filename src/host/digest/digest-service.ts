import { extractiveDigest, SUMMARIZER_VERSION, type SessionDigest } from '../../memory/digest';
import type { DigestMeta, MemoryStore } from '../../memory/types';
import type { SessionId, TranscriptItem } from '../../protocol/messages';

export interface DigestSession {
  id: SessionId; providerId: string; cwd: string; title: string; hidden: boolean; updatedAt: number;
}

export interface DigestSource {
  sessions(): DigestSession[];
  transcript(id: SessionId): Promise<TranscriptItem[]>;
  /** `forUpdatedAt` of the projection currently on the session, if any. */
  projected(id: SessionId): number | undefined;
}

export type DigestScope = 'all' | 'missing-llm';
export interface DigestProgress { phase: 'extractive' | 'llm' | 'done' | 'cancelled'; done: number; total: number }
export interface DigestEstimate { sessions: number; approxInputTokens: number }

type Summarizer = {
  summarize(items: TranscriptItem[], base: SessionDigest): Promise<SessionDigest>;
  /** How many summaries a reindex may run at once. */
  concurrency?: number;
};

export interface DigestServiceOptions {
  store: MemoryStore;
  source: DigestSource;
  summarizer?: Summarizer;
  onDigest(id: SessionId, digest: SessionDigest): void;
  onSettled(): void;
  onProgress(p: DigestProgress): void;
}

const APPROX_TOKENS_PER_SESSION = 3000;
const SETTLE_EVERY = 10;
const DEFAULT_LLM_CONCURRENCY = 3;

const isCurrent = (meta: DigestMeta | undefined, session: DigestSession): boolean =>
  meta !== undefined && meta.forUpdatedAt === session.updatedAt && meta.summarizerVersion === SUMMARIZER_VERSION;

export class DigestService {
  private summarizer: Summarizer | undefined;
  private fast: Promise<void> = Promise.resolve();
  private slow: Promise<void> = Promise.resolve();
  private cancelled = false;
  private stopped = false;
  private reindexing: Promise<void> | undefined;

  constructor(private readonly o: DigestServiceOptions) {
    this.summarizer = o.summarizer;
  }

  setSummarizer(summarizer: Summarizer | undefined): void { this.summarizer = summarizer; }
  hasSummarizer(): boolean { return this.summarizer !== undefined; }
  cancel(): void { this.cancelled = true; }
  stop(): void { this.stopped = true; this.cancelled = true; }

  /**
   * Two serial lanes. Extractive writes are cheap and awaited by close, hide, delete and shutdown, so
   * they must never wait behind a model call that can run for its whole timeout; those get their own
   * lane. Each write is its own job so a close-time write can also slip between a sweep's.
   */
  private enqueue<T>(lane: 'fast' | 'slow', job: () => Promise<T>): Promise<T> {
    const run = (lane === 'fast' ? this.fast : this.slow).then(job);
    const tail = run.then(() => undefined, () => undefined);
    if (lane === 'fast') { this.fast = tail; } else { this.slow = tail; }
    return run;
  }

  private find(id: SessionId): DigestSession | undefined {
    return this.o.source.sessions().find((s) => s.id === id);
  }

  /**
   * History wants a summary for every session, but recall and priming are for hidden ones only: a
   * session shown in a pane is projected onto `SessionState.summary` and never written to the store.
   */
  private async projectLive(session: DigestSession): Promise<boolean> {
    if (this.o.source.projected(session.id) === session.updatedAt) { return false; }
    const digest = extractiveDigest(await this.o.source.transcript(session.id), session.updatedAt);
    if (!digest) { return false; }
    this.o.onDigest(session.id, digest);
    return true;
  }

  private async writeExtractive(session: DigestSession, force = false): Promise<boolean> {
    if (this.stopped || session.title === 'Untitled') { return false; }
    try {
      if (!session.hidden) { return await this.projectLive(session); }
      if (!force) {
        // A current digest of either source already describes this transcript; rewriting it as
        // extractive would throw away a paid-for LLM digest.
        const existing = await this.o.store.getDigest(session.id);
        if (existing && isCurrent(existing, session)) {
          if (this.o.source.projected(session.id) === session.updatedAt) { return false; }
          this.o.onDigest(session.id, existing);
          return true;
        }
      }
      const items = await this.o.source.transcript(session.id);
      const digest = extractiveDigest(items, session.updatedAt);
      if (!digest) { return false; }
      await this.o.store.index({
        sessionId: session.id, providerId: session.providerId, cwd: session.cwd,
        closedAt: session.updatedAt, items, digest,
      });
      this.o.onDigest(session.id, digest);
      return true;
    } catch (err) {
      console.error('[mar-code] digest failed for', session.id, err);
      return false;
    }
  }

  private async writeLlm(session: DigestSession): Promise<boolean> {
    const summarizer = this.summarizer;
    if (this.stopped || !summarizer || !session.hidden || session.title === 'Untitled') { return false; }
    try {
      const items = await this.o.source.transcript(session.id);
      const base = extractiveDigest(items, session.updatedAt);
      if (!base) { return false; }
      const digest = await summarizer.summarize(items, base);
      // Deleted or shown again while the model was thinking: indexing now would resurrect or re-expose it.
      if (this.stopped || !this.find(session.id)?.hidden) { return false; }
      await this.o.store.index({
        sessionId: session.id, providerId: session.providerId, cwd: session.cwd,
        closedAt: session.updatedAt, items, digest,
      });
      this.o.onDigest(session.id, digest);
      return true;
    } catch (err) {
      console.error('[mar-code] llm digest failed for', session.id, err);
      return false;
    }
  }

  async refresh(id: SessionId): Promise<void> {
    await this.enqueue('fast', async () => {
      const session = this.find(id);
      if (session && await this.writeExtractive(session)) { this.o.onSettled(); }
    });
  }

  async upgrade(id: SessionId): Promise<void> {
    await this.enqueue('slow', async () => {
      const session = this.find(id);
      if (session && await this.writeLlm(session)) { this.o.onSettled(); }
    });
  }

  /** Drops a session from the store, in line behind any write already queued for it. */
  async forget(id: SessionId): Promise<void> {
    await this.enqueue('fast', async () => {
      try {
        await this.o.store.forget(id);
      } catch (err) {
        console.error('[mar-code] digest forget failed for', id, err);
      }
    });
  }

  /**
   * A digest for a handoff prompt. Read-only: never writes the store, projects onto the session or
   * touches `updatedAt`, so a handoff cannot become a second writer. Never rejects — any failure
   * degrades to the extractive digest.
   */
  digestForHandoff(id: SessionId): Promise<{ digest: SessionDigest; source: 'llm' | 'extractive' } | undefined> {
    return this.enqueue('slow', async () => {
      const session = this.find(id);
      if (!session) { return undefined; }
      try {
        if (session.hidden) {
          const stored = await this.o.store.getDigest(id);
          if (stored?.source === 'llm' && isCurrent(stored, session)) { return { digest: stored, source: 'llm' as const }; }
        }
        const items = await this.o.source.transcript(id);
        const base = extractiveDigest(items, session.updatedAt);
        if (!base) { return undefined; }
        if (this.summarizer && !this.stopped) {
          try {
            return { digest: await this.summarizer.summarize(items, base), source: 'llm' as const };
          } catch (err) {
            console.error('[mar-code] handoff summary failed for', id, err);
          }
        }
        return { digest: base, source: 'extractive' as const };
      } catch (err) {
        console.error('[mar-code] handoff digest failed for', id, err);
        return undefined;
      }
    });
  }

  async resummarize(id: SessionId): Promise<void> {
    await this.refresh(id);
    await this.upgrade(id);
  }

  async ensureCurrent(): Promise<void> {
    try {
      const meta = await this.o.store.digestMeta();
      let touched = false;
      for (const session of this.o.source.sessions()) {
        if (this.stopped) { break; }
        if (session.title === 'Untitled') { continue; }
        const wrote = await this.enqueue('fast', async () => {
          if (!session.hidden) { return this.writeExtractive(session); }
          if (!isCurrent(meta.get(session.id), session)) { return this.writeExtractive(session, true); }
          if (this.o.source.projected(session.id) === session.updatedAt) { return false; }
          const digest = await this.o.store.getDigest(session.id);
          if (!digest) { return false; }
          this.o.onDigest(session.id, digest);
          return true;
        });
        if (wrote) { touched = true; }
      }
      if (touched) { this.o.onSettled(); }
    } catch (err) {
      console.error('[mar-code] digest refresh failed', err);
    }
  }

  private llmTargets(scope: DigestScope, meta: Map<SessionId, DigestMeta>): DigestSession[] {
    if (!this.summarizer) { return []; }
    return this.o.source.sessions()
      .filter((s) => s.hidden && s.title !== 'Untitled')
      .filter((s) => scope === 'all' || !(meta.get(s.id)?.source === 'llm' && isCurrent(meta.get(s.id), s)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async estimate(scope: DigestScope): Promise<DigestEstimate> {
    const sessions = this.llmTargets(scope, await this.o.store.digestMeta()).length;
    return { sessions, approxInputTokens: sessions * APPROX_TOKENS_PER_SESSION };
  }

  reindex(scope: DigestScope): Promise<void> {
    this.reindexing ??= this.runReindex(scope)
      .catch((err) => { console.error('[mar-code] memory reindex failed', err); })
      .finally(() => { this.reindexing = undefined; });
    return this.reindexing;
  }

  private async runReindex(scope: DigestScope): Promise<void> {
    this.cancelled = false;
    const meta = await this.o.store.digestMeta();
    const all = this.o.source.sessions().filter((s) => s.title !== 'Untitled');
    const extractive = all
      .filter((s) => scope === 'all' || !isCurrent(meta.get(s.id), s))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const llm = this.llmTargets(scope, meta);

    let done = 0;
    for (const session of extractive) {
      if (this.cancelled) { return this.finish('cancelled', done, extractive.length); }
      await this.enqueue('fast', () => this.writeExtractive(session, true));
      done++;
      this.o.onProgress({ phase: 'extractive', done, total: extractive.length });
      if (done % SETTLE_EVERY === 0) { this.o.onSettled(); }
    }
    this.o.onSettled();

    done = 0;
    let next = 0;
    // Bypasses the slow lane: that lane serializes single upgrades, and each model call is an independent run.
    const worker = async (): Promise<void> => {
      while (!this.cancelled && next < llm.length) {
        const session = llm[next++];
        await this.writeLlm(session);
        done++;
        this.o.onProgress({ phase: 'llm', done, total: llm.length });
        if (done % SETTLE_EVERY === 0) { this.o.onSettled(); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.summarizer?.concurrency ?? DEFAULT_LLM_CONCURRENCY, llm.length) }, worker));
    this.finish(this.cancelled ? 'cancelled' : 'done', done, llm.length);
  }

  private finish(phase: 'done' | 'cancelled', done: number, total: number): void {
    this.o.onSettled();
    this.o.onProgress({ phase, done, total });
  }
}
