import { extractiveDigest, SUMMARIZER_VERSION, type SessionDigest } from '../../memory/digest';
import type { DigestMeta, MemoryStore } from '../../memory/types';
import type { SessionId, TranscriptItem } from '../../protocol/messages';

export interface DigestSession {
  id: SessionId; providerId: string; cwd: string; title: string; archived: boolean; updatedAt: number;
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

type Summarizer = { summarize(items: TranscriptItem[], base: SessionDigest): Promise<SessionDigest> };

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

const isCurrent = (meta: DigestMeta | undefined, session: DigestSession): boolean =>
  meta !== undefined && meta.forUpdatedAt === session.updatedAt && meta.summarizerVersion === SUMMARIZER_VERSION;

export class DigestService {
  private summarizer: Summarizer | undefined;
  private queue: Promise<void> = Promise.resolve();
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

  /** One job at a time; every write is its own job so a close-time write can slip between a reindex's. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private find(id: SessionId): DigestSession | undefined {
    return this.o.source.sessions().find((s) => s.id === id);
  }

  private async writeExtractive(session: DigestSession): Promise<boolean> {
    if (this.stopped || session.title === 'Untitled') { return false; }
    try {
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
    if (this.stopped || !summarizer || !session.archived || session.title === 'Untitled') { return false; }
    try {
      const items = await this.o.source.transcript(session.id);
      const base = extractiveDigest(items, session.updatedAt);
      if (!base) { return false; }
      const digest = await summarizer.summarize(items, base);
      // The session may have been deleted while the model was thinking; indexing now would resurrect it.
      if (this.stopped || !this.find(session.id)) { return false; }
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
    await this.enqueue(async () => {
      const session = this.find(id);
      if (session && await this.writeExtractive(session)) { this.o.onSettled(); }
    });
  }

  async upgrade(id: SessionId): Promise<void> {
    await this.enqueue(async () => {
      const session = this.find(id);
      if (session && await this.writeLlm(session)) { this.o.onSettled(); }
    });
  }

  async resummarize(id: SessionId): Promise<void> {
    await this.refresh(id);
    await this.upgrade(id);
  }

  async ensureCurrent(): Promise<void> {
    await this.enqueue(async () => {
      try {
        const meta = await this.o.store.digestMeta();
        let touched = false;
        for (const session of this.o.source.sessions()) {
          if (this.stopped) { return; }
          if (session.title === 'Untitled') { continue; }
          const stored = meta.get(session.id);
          if (!isCurrent(stored, session)) {
            if (await this.writeExtractive(session)) { touched = true; }
          } else if (this.o.source.projected(session.id) !== session.updatedAt) {
            const digest = await this.o.store.getDigest(session.id);
            if (digest) { this.o.onDigest(session.id, digest); touched = true; }
          }
        }
        if (touched) { this.o.onSettled(); }
      } catch (err) {
        console.error('[mar-code] digest refresh failed', err);
      }
    });
  }

  private llmTargets(scope: DigestScope, meta: Map<SessionId, DigestMeta>): DigestSession[] {
    if (!this.summarizer) { return []; }
    return this.o.source.sessions()
      .filter((s) => s.archived && s.title !== 'Untitled')
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
      await this.enqueue(() => this.writeExtractive(session));
      done++;
      this.o.onProgress({ phase: 'extractive', done, total: extractive.length });
      if (done % SETTLE_EVERY === 0) { this.o.onSettled(); }
    }
    this.o.onSettled();

    done = 0;
    for (const session of llm) {
      if (this.cancelled) { return this.finish('cancelled', done, llm.length); }
      await this.enqueue(() => this.writeLlm(session));
      done++;
      this.o.onProgress({ phase: 'llm', done, total: llm.length });
      if (done % SETTLE_EVERY === 0) { this.o.onSettled(); }
    }
    this.finish('done', done, llm.length);
  }

  private finish(phase: 'done' | 'cancelled', done: number, total: number): void {
    this.o.onSettled();
    this.o.onProgress({ phase, done, total });
  }
}
