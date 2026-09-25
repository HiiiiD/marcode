import type { SessionId, TranscriptItem } from '../protocol/messages';
import type { SessionDigest } from './digest';

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
  /** Where the session ran, so a caller can scope recall to a workspace folder. */
  cwd: string;
}

export interface MemoryDetail {
  sessionId: SessionId;
  /** A bounded slice, never a whole transcript. */
  items: TranscriptItem[];
}

/** What `MemoryStore.index()` needs to make one session findable later. */
export interface SessionRecord {
  sessionId: SessionId;
  providerId: string;
  cwd: string;
  closedAt: number;
  /** The full transcript at index time — the caller already has this in memory. */
  items: TranscriptItem[];
  /** Absent means "build the extractive digest from `items`". */
  digest?: SessionDigest;
}

export type DigestMeta = Pick<SessionDigest, 'source' | 'summarizerVersion' | 'forUpdatedAt'>;

/**
 * The swappable seam. v1 ships `FtsMemoryStore` (SQLite + FTS5); a future
 * semantic/embedding implementation is a new class behind this same
 * interface. JSONL transcripts remain the source of truth — whatever this
 * interface's implementation persists is a rebuildable cache, never migrated
 * when the implementation changes, only rebuilt from `index()` calls again.
 */
export interface MemoryStore {
  /** Called when a session archives, and by the history and reindex passes for any session with content. */
  index(record: SessionRecord): Promise<void>;
  /**
   * Cheap: snippets, not full content. `match` defaults to `'all'` (every term
   * must appear); `'any'` ranks sessions sharing at least one, for a caller
   * holding a whole prompt rather than a hand-picked keyword.
   */
  search(
    query: string,
    opts?: { providerId?: string; limit?: number; match?: 'all' | 'any'; cwdWithin?: string },
  ): Promise<MemoryHit[]>;
  /** Full slice for exactly one hit, on demand. */
  fetch(hit: { sessionId: SessionId; itemId: string }): Promise<MemoryDetail>;
  /**
   * Erases a session's row, if any. Called when a session is permanently
   * deleted — `remove()`, not `close()` — so an explicit delete cannot leave
   * the transcript it was meant to erase permanently findable in this cache.
   */
  forget(sessionId: SessionId): Promise<void>;
  /** The stored digest for one session, if any. */
  getDigest(sessionId: SessionId): Promise<SessionDigest | undefined>;
  /** Cheap: every stored digest's freshness, so a caller can skip current ones. */
  digestMeta(): Promise<Map<SessionId, DigestMeta>>;
}
