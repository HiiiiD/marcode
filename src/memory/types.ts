import type { SessionId, TranscriptItem } from '../protocol/messages';

/**
 * One search result. Deliberately snippet-only, never a `TranscriptItem[]` —
 * this is the token-efficiency seam: a caller reads a page of these before
 * ever paying for a `fetch()`. See the design spec's "Modularity / swap
 * story" section.
 */
export interface MemoryHit {
  sessionId: SessionId;
  /** Anchors `fetch()` to a point in that session's transcript. */
  itemId: string;
  /** Short by construction — a summary, never raw transcript text. */
  snippet: string;
  score: number;
  ts: number;
}

export interface MemoryDetail {
  sessionId: SessionId;
  /** A bounded slice, never a whole transcript. */
  items: TranscriptItem[];
}

/** What `MemoryStore.index()` needs to make one closed session findable later. */
export interface SessionRecord {
  sessionId: SessionId;
  providerId: string;
  cwd: string;
  title: string;
  closedAt: number;
  /** The full transcript at close time — the caller already has this in memory. */
  items: TranscriptItem[];
}

/**
 * The swappable seam. v1 ships `FtsMemoryStore` (SQLite + FTS5); a future
 * semantic/embedding implementation is a new class behind this same
 * interface. JSONL transcripts remain the source of truth — whatever this
 * interface's implementation persists is a rebuildable cache, never migrated
 * when the implementation changes, only rebuilt from `index()` calls again.
 */
export interface MemoryStore {
  /** Called once a session archives. Never called on a live session. */
  index(record: SessionRecord): Promise<void>;
  /** Cheap: snippets, not full content. */
  search(query: string, opts?: { providerId?: string; limit?: number }): Promise<MemoryHit[]>;
  /** Full slice for exactly one hit, on demand. */
  fetch(hit: { sessionId: SessionId; itemId: string }): Promise<MemoryDetail>;
}

/**
 * How `index()` gets its short, human-readable summary. A second, independently
 * swappable seam nested inside a `MemoryStore` implementation: v1's
 * `ExtractiveSummarizer` makes no LLM call; a future LLM-backed one implements
 * the same one-method contract.
 */
export interface Summarizer {
  summarize(items: TranscriptItem[]): Promise<string>;
}
