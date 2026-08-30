# Cross-provider memory (backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a live Marcode session recall content from earlier, already-closed Marcode
sessions (any provider) via two cheap MCP tools, without ever loading a full transcript
into context, backed by a swappable `MemoryStore` interface.

**Architecture:** A new `src/memory/` module: a types-only `MemoryStore`/`Summarizer`
contract, one v1 implementation (`FtsMemoryStore`, SQLite FTS5 via `node:sqlite`) and one
v1 `Summarizer` (`ExtractiveSummarizer`, no LLM call). `SessionManager` indexes a session
into the store the moment it archives. `SelfControlMcpServer` gains two tools —
`marcode__recall` (search, snippets only) and `marcode__recall_fetch` (one bounded slice,
on demand) — mirroring the existing `marcode__spawn_session` tool's shape.

**Tech Stack:** TypeScript, `node:sqlite` (stable in Node 22, this project's extension-host
target — no new npm dependency), mocha (`suite`/`test`, per `src/test/unit/*.test.ts`
convention), `@modelcontextprotocol/sdk` (already a dependency, used by
`self-control-mcp-server.ts`).

**Spec:** [docs/superpowers/specs/2026-08-30-cross-provider-memory-design.md](../specs/2026-08-30-cross-provider-memory-design.md)

## Global Constraints

- No `vscode` import anywhere under `src/memory/`, `src/host/self-control-mcp-server.ts`, or
  `src/host/session-manager.ts` — same unit-testability boundary the spec and `CLAUDE.md`
  already require for `src/providers/` and `src/host/message-router.ts`.
- JSONL transcripts stay the single source of truth. `memory.sqlite` is a rebuildable
  cache: an index failure is logged and swallowed, never thrown, and never blocks the
  session lifecycle event it is hooked to.
- Filenames are kebab-case (`fts-memory-store.ts`, not `FtsMemoryStore.ts`).
- `yarn lint`, `yarn check-types`, `yarn run compile` must all pass before each commit.
- Conventional-commit prefixes (`feat:`, `test:`, `chore:`); commit after every task.

## Scope note

This plan covers the backend subsystem only: the `MemoryStore` contract, its v1
implementation, `SessionManager` wiring, and the two MCP tools. The spec's human
browse/search surface (a new review-tab tab) is an independent subsystem — its own webview
components, its own `ReviewState` slice, its own `impeccable` pass — and is deliberately a
separate follow-up plan, written once this backend exists for it to call into.

---

### Task 1: Memory types

**Files:**
- Create: `src/memory/types.ts`

**Interfaces:**
- Produces: `MemoryHit { sessionId: SessionId; itemId: string; snippet: string; score: number; ts: number }`,
  `MemoryDetail { sessionId: SessionId; items: TranscriptItem[] }`,
  `SessionRecord { sessionId: SessionId; providerId: string; cwd: string; title: string; closedAt: number; items: TranscriptItem[] }`,
  `MemoryStore { index(record): Promise<void>; search(query, opts?): Promise<MemoryHit[]>; fetch(hit): Promise<MemoryDetail> }`,
  `Summarizer { summarize(items: TranscriptItem[]): Promise<string> }`.

This is a types-only file, the same boundary `src/protocol/messages.ts` and
`src/providers/types.ts` already keep — there is no runtime behavior here to unit test
(the project's own precedent: neither of those files has a dedicated test). It is
verified by `yarn check-types` and by every later task's real usage of these types.

- [ ] **Step 1: Write the file**

```typescript
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
```

- [ ] **Step 2: Type-check**

Run: `yarn check-types`
Expected: passes (nothing imports this file yet, so this only confirms the file itself is
valid TypeScript).

- [ ] **Step 3: Commit**

```bash
git add src/memory/types.ts
git commit -m "feat: add MemoryStore/Summarizer contract types"
```

---

### Task 2: ExtractiveSummarizer

**Files:**
- Create: `src/memory/extractive-summarizer.ts`
- Test: `src/test/unit/extractive-summarizer.test.ts`

**Interfaces:**
- Consumes: `Summarizer`, `TranscriptItem` from Task 1 / `src/protocol/messages`.
- Produces: `ExtractiveSummarizer implements Summarizer` — `new ExtractiveSummarizer().summarize(items)`.

- [ ] **Step 1: Write the failing tests**

```typescript
import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { ExtractiveSummarizer } from '../../memory/extractive-summarizer';
import type { TranscriptItem } from '../../protocol/messages';

function userItem(text: string): TranscriptItem {
  return { id: 'u1', ts: 0, role: 'user', text };
}
function assistantItem(text: string): TranscriptItem {
  return { id: 'a1', ts: 1, role: 'assistant', text };
}

suite('ExtractiveSummarizer', () => {
  test('summarizes from the first user message and the item count', async () => {
    const summarizer = new ExtractiveSummarizer();
    const summary = await summarizer.summarize([
      userItem('Fix the flaky login test'),
      assistantItem('Looking into it'),
      userItem('Any luck?'),
    ]);
    assert.strictEqual(summary, 'Fix the flaky login test (3 messages)');
  });

  test('truncates a long first message to 200 characters', async () => {
    const summarizer = new ExtractiveSummarizer();
    const long = 'x'.repeat(250);
    const summary = await summarizer.summarize([userItem(long)]);
    assert.strictEqual(summary, `${'x'.repeat(200)}… (1 message)`);
  });

  test('falls back to a fixed label when there is no user message', async () => {
    const summarizer = new ExtractiveSummarizer();
    const summary = await summarizer.summarize([assistantItem('hello')]);
    assert.strictEqual(summary, 'Untitled session (1 message)');
  });

  test('handles an empty transcript', async () => {
    const summarizer = new ExtractiveSummarizer();
    const summary = await summarizer.summarize([]);
    assert.strictEqual(summary, 'Untitled session (0 messages)');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit --grep ExtractiveSummarizer`
Expected: FAIL — `Cannot find module '../../memory/extractive-summarizer'`

- [ ] **Step 3: Write the implementation**

```typescript
import type { TranscriptItem } from '../protocol/messages';
import type { Summarizer } from './types';

const MAX_SNIPPET_LENGTH = 200;

/**
 * v1's `Summarizer`: no LLM call, no added latency or cost on session
 * archive. First user message (truncated) plus a message count — enough for
 * a search snippet and a browse-list row. An LLM-backed `Summarizer` is a
 * drop-in replacement behind the same one-method contract.
 */
export class ExtractiveSummarizer implements Summarizer {
  async summarize(items: TranscriptItem[]): Promise<string> {
    const firstUser = items.find((i): i is TranscriptItem & { role: 'user'; text: string } => i.role === 'user');
    const label = items.length === 1 ? 'message' : 'messages';
    const suffix = `(${items.length} ${label})`;
    if (!firstUser || firstUser.text.length === 0) {
      return `Untitled session ${suffix}`;
    }
    const text = firstUser.text.length > MAX_SNIPPET_LENGTH
      ? `${firstUser.text.slice(0, MAX_SNIPPET_LENGTH)}…`
      : firstUser.text;
    return `${text} ${suffix}`;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit --grep ExtractiveSummarizer`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/extractive-summarizer.ts src/test/unit/extractive-summarizer.test.ts
git commit -m "feat: add ExtractiveSummarizer"
```

---

### Task 3: FtsMemoryStore — index() and search()

**Files:**
- Create: `src/memory/fts-memory-store.ts`
- Test: `src/test/unit/fts-memory-store.test.ts`

**Interfaces:**
- Consumes: `MemoryStore`, `MemoryHit`, `SessionRecord`, `Summarizer` (Task 1),
  `ExtractiveSummarizer` (Task 2, used only in the test as a real summarizer).
- Produces: `FtsMemoryStore implements MemoryStore` —
  `new FtsMemoryStore(dbPath: string, summarizer: Summarizer, transcripts: TranscriptReader)`,
  `.index(record)`, `.search(query, opts?)`. (`.fetch()` lands in Task 4 — see the
  `TranscriptReader` interface defined there; this task's tests construct the store with a
  minimal fake that satisfies it structurally, `{ tail: async () => ({ items: [], hasMore: false }) }`,
  since `index()`/`search()` never call it.)

`node:sqlite`'s `DatabaseSync` is synchronous — every method below stays `async` only
because the interface requires it (matching the interface `MemoryStore` declares, and
leaving room for a future implementation that genuinely awaits I/O).

- [ ] **Step 1: Write the failing tests**

```typescript
import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { ExtractiveSummarizer } from '../../memory/extractive-summarizer';
import { FtsMemoryStore } from '../../memory/fts-memory-store';
import type { TranscriptItem } from '../../protocol/messages';

const noopReader = { tail: async () => ({ items: [] as TranscriptItem[], hasMore: false }) };

function userItem(id: string, text: string): TranscriptItem {
  return { id, ts: 0, role: 'user', text };
}

async function tempDbPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-memory-'));
  return path.join(dir, 'memory.sqlite');
}

suite('FtsMemoryStore', () => {
  test('search() finds an indexed session by keyword', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), new ExtractiveSummarizer(), noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', title: 'Untitled', closedAt: 1000,
      items: [userItem('u1', 'Investigate the flaky login test on CI')],
    });
    const hits = await store.search('flaky login');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].sessionId, 's1');
    assert.strictEqual(hits[0].itemId, 'u1');
    assert.strictEqual(hits[0].snippet.includes('flaky login test'), true);
  });

  test('search() returns nothing for an unrelated query', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), new ExtractiveSummarizer(), noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', title: 'Untitled', closedAt: 1000,
      items: [userItem('u1', 'Investigate the flaky login test on CI')],
    });
    const hits = await store.search('database migration');
    assert.strictEqual(hits.length, 0);
  });

  test('search() filters by providerId', async () => {
    const dbPath = await tempDbPath();
    const store = new FtsMemoryStore(dbPath, new ExtractiveSummarizer(), noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', title: 'Untitled', closedAt: 1000,
      items: [userItem('u1', 'Investigate the flaky login test')],
    });
    await store.index({
      sessionId: 's2', providerId: 'codex', cwd: '/repo', title: 'Untitled', closedAt: 2000,
      items: [userItem('u2', 'Investigate the flaky login test')],
    });
    const hits = await store.search('flaky login', { providerId: 'codex' });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].sessionId, 's2');
  });

  test('re-indexing the same sessionId replaces, not duplicates', async () => {
    const dbPath = await tempDbPath();
    const store = new FtsMemoryStore(dbPath, new ExtractiveSummarizer(), noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', title: 'Untitled', closedAt: 1000,
      items: [userItem('u1', 'Investigate the flaky login test')],
    });
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', title: 'Untitled', closedAt: 2000,
      items: [userItem('u2', 'Investigate the flaky login test')],
    });
    const hits = await store.search('flaky login');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].itemId, 'u2');
  });

  test('search() respects the limit option', async () => {
    const dbPath = await tempDbPath();
    const store = new FtsMemoryStore(dbPath, new ExtractiveSummarizer(), noopReader);
    for (const n of [1, 2, 3]) {
      await store.index({
        sessionId: `s${n}`, providerId: 'claude', cwd: '/repo', title: 'Untitled', closedAt: n,
        items: [userItem(`u${n}`, 'Investigate the flaky login test')],
      });
    }
    const hits = await store.search('flaky login', { limit: 2 });
    assert.strictEqual(hits.length, 2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit --grep FtsMemoryStore`
Expected: FAIL — `Cannot find module '../../memory/fts-memory-store'`

- [ ] **Step 3: Write the implementation**

```typescript
import { DatabaseSync } from 'node:sqlite';
import type { SessionId, TranscriptItem } from '../protocol/messages';
import type { MemoryDetail, MemoryHit, MemoryStore, SessionRecord, Summarizer } from './types';

/**
 * The slice of `TranscriptStore` this store needs to answer `fetch()` — see
 * Task 4. Declared structurally, not imported from `transcript-store.ts`, so
 * this module carries no `vscode` import in its graph and stays unit-testable
 * with a fake, the same boundary `SessionManagerLike` keeps in
 * `self-control-mcp-server.ts`.
 */
export interface TranscriptReader {
  tail(id: SessionId, limit?: number): Promise<{ items: TranscriptItem[]; hasMore: boolean }>;
}

/** How many items around the anchor `fetch()` returns. See Task 4. */
export const FETCH_WINDOW = 40;

/**
 * v1's only `MemoryStore`: one FTS5 row per session, upserted whenever that
 * session archives. Indexes at session granularity, not per-turn — a hit's
 * `itemId` anchors to the session's first item, and `fetch()` (Task 4) reads
 * forward from there. Per-turn granularity is future work (see the design
 * spec's Deferred section).
 *
 * JSONL transcripts remain the source of truth; this file is a rebuildable
 * cache — see the design spec's "Modularity / swap story".
 */
export class FtsMemoryStore implements MemoryStore {
  private readonly db: DatabaseSync;

  constructor(
    dbPath: string,
    private readonly summarizer: Summarizer,
    private readonly transcripts: TranscriptReader,
  ) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        title, summary, text,
        sessionId UNINDEXED, providerId UNINDEXED, cwd UNINDEXED,
        firstItemId UNINDEXED, closedAt UNINDEXED
      );
    `);
  }

  async index(record: SessionRecord): Promise<void> {
    const firstItemId = record.items[0]?.id;
    if (!firstItemId) { return; } // nothing to anchor a future fetch() to
    const summary = await this.summarizer.summarize(record.items);
    const text = record.items
      .map((i) => ('text' in i ? i.text : ''))
      .filter((t) => t.length > 0)
      .join('\n');

    this.db.prepare('DELETE FROM sessions_fts WHERE sessionId = ?').run(record.sessionId);
    this.db.prepare(`
      INSERT INTO sessions_fts (title, summary, text, sessionId, providerId, cwd, firstItemId, closedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.title, summary, text,
      record.sessionId, record.providerId, record.cwd, firstItemId, record.closedAt,
    );
  }

  async search(query: string, opts: { providerId?: string; limit?: number } = {}): Promise<MemoryHit[]> {
    const limit = opts.limit ?? 20;
    const providerId = opts.providerId ?? null;
    const rows = this.db.prepare(`
      SELECT sessionId, firstItemId, summary, closedAt, providerId, bm25(sessions_fts) AS rank
      FROM sessions_fts
      WHERE sessions_fts MATCH ?
        AND (? IS NULL OR providerId = ?)
      ORDER BY rank
      LIMIT ?
    `).all(query, providerId, providerId, limit) as Array<{
      sessionId: string; firstItemId: string; summary: string; closedAt: number;
      providerId: string; rank: number;
    }>;
    return rows.map((row) => ({
      sessionId: row.sessionId,
      itemId: row.firstItemId,
      snippet: row.summary,
      // bm25() is negative and lower-is-better; flip sign so a caller reads
      // "higher score is more relevant", the ordinary convention.
      score: -row.rank,
      ts: row.closedAt,
    }));
  }

  async fetch(hit: { sessionId: SessionId; itemId: string }): Promise<MemoryDetail> {
    const { items } = await this.transcripts.tail(hit.sessionId, Number.MAX_SAFE_INTEGER);
    const at = items.findIndex((i) => i.id === hit.itemId);
    if (at < 0) { return { sessionId: hit.sessionId, items: [] }; }
    return { sessionId: hit.sessionId, items: items.slice(at, at + FETCH_WINDOW) };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit --grep FtsMemoryStore`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/fts-memory-store.ts src/test/unit/fts-memory-store.test.ts
git commit -m "feat: add FtsMemoryStore index/search"
```

---

### Task 4: FtsMemoryStore — fetch()

**Files:**
- Modify: `src/test/unit/fts-memory-store.test.ts` (add fetch() tests; `fetch()` itself
  already exists from Task 3 — this task is where it gets exercised and, if needed, fixed)

**Interfaces:**
- Consumes: `TranscriptReader` (Task 3).
- Produces: nothing new — this task is verification of the `fetch()` method Task 3 already
  wrote, using a real fake `TranscriptReader` instead of the `noopReader` stub.

- [ ] **Step 1: Write the failing tests**

Add to `src/test/unit/fts-memory-store.test.ts`:

```typescript
function fakeReader(items: TranscriptItem[]): { tail: (id: string, limit?: number) => Promise<{ items: TranscriptItem[]; hasMore: boolean }> } {
  return {
    tail: async (_id, limit = 100) => {
      const start = Math.max(0, items.length - limit);
      return { items: items.slice(start), hasMore: start > 0 };
    },
  };
}

suite('FtsMemoryStore.fetch()', () => {
  test('returns a bounded slice starting at the hit\'s itemId', async () => {
    const items = [userItem('u1', 'first'), userItem('u2', 'second'), userItem('u3', 'third')];
    const store = new FtsMemoryStore(await tempDbPath(), new ExtractiveSummarizer(), fakeReader(items));
    await store.index({ sessionId: 's1', providerId: 'claude', cwd: '/repo', title: 'Untitled', closedAt: 1, items });
    const [hit] = await store.search('first');
    const detail = await store.fetch(hit);
    assert.strictEqual(detail.sessionId, 's1');
    assert.strictEqual(detail.items.length, 3);
    assert.strictEqual(detail.items[0].id, 'u1');
  });

  test('returns an empty slice when the itemId is no longer in the transcript', async () => {
    const items = [userItem('u1', 'first')];
    const store = new FtsMemoryStore(await tempDbPath(), new ExtractiveSummarizer(), fakeReader(items));
    await store.index({ sessionId: 's1', providerId: 'claude', cwd: '/repo', title: 'Untitled', closedAt: 1, items });
    const detail = await store.fetch({ sessionId: 's1', itemId: 'gone' });
    assert.strictEqual(detail.items.length, 0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail (or pass already)**

Run: `yarn test:unit --grep "FtsMemoryStore.fetch"`
Expected: PASS already, since Task 3 wrote a correct `fetch()` — this step exists to prove
it with real coverage rather than the `noopReader` stub. If it fails, fix `fetch()` in
`src/memory/fts-memory-store.ts` until it does.

- [ ] **Step 3: Commit**

```bash
git add src/test/unit/fts-memory-store.test.ts
git commit -m "test: cover FtsMemoryStore.fetch() with a real TranscriptReader fake"
```

---

### Task 5: Wire `MemoryStore` into `SessionManager`

**Files:**
- Modify: `src/host/session-manager.ts` (constructor + `archive()`)
- Test: `src/test/unit/session-manager-memory.test.ts`

**Interfaces:**
- Consumes: `MemoryStore`, `SessionRecord` (Task 1).
- Produces: `SessionManager`'s constructor gains a trailing optional
  `memory?: MemoryStore` parameter (after `extraBaseRefs`, matching the file's existing
  "new optional param goes last" pattern). `archive(id)` calls
  `this.memory?.index(record)` fire-and-forget, swallowing and logging any rejection.

- [ ] **Step 1: Write the failing test**

```typescript
import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';
import type { MemoryStore, SessionRecord } from '../../memory/types';

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'marcode-session-manager-'));
}

class RecordingMemoryStore implements MemoryStore {
  indexed: SessionRecord[] = [];
  async index(record: SessionRecord): Promise<void> { this.indexed.push(record); }
  async search(): Promise<[]> { return []; }
  async fetch(): Promise<{ sessionId: string; items: [] }> { return { sessionId: '', items: [] }; }
}

suite('SessionManager memory indexing', () => {
  test('archiving a session with real content indexes it', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory = new RecordingMemoryStore();
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    const session = await manager.create('fake', '/repo');
    // AgentSession.send() appends the user item and stamps the title
    // synchronously (see `deliver()` in agent-session.ts) — no need to wait
    // for a turn to complete before archiving.
    session.send('Investigate the flaky login test');
    await manager.close(session.state.id);
    assert.strictEqual(memory.indexed.length, 1);
    assert.strictEqual(memory.indexed[0].sessionId, session.state.id);
  });

  test('archiving an untitled, empty session does not index it', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory = new RecordingMemoryStore();
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    const session = await manager.create('fake', '/repo');
    await manager.close(session.state.id);
    assert.strictEqual(memory.indexed.length, 0);
  });

  test('a rejecting MemoryStore does not stop archive() from completing', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory: MemoryStore = {
      index: async () => { throw new Error('disk full'); },
      search: async () => [],
      fetch: async () => ({ sessionId: '', items: [] }),
    };
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    const session = await manager.create('fake', '/repo');
    session.send('Investigate the flaky login test');
    await assert.doesNotReject(manager.close(session.state.id));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit --grep "SessionManager memory indexing"`
Expected: FAIL — `SessionManager` constructor does not accept a 9th argument (TypeScript
error) or, once that's stubbed, `memory.indexed.length` is `0` where `1` is expected.

- [ ] **Step 3: Implement**

In `src/host/session-manager.ts`, add the import and constructor parameter:

```typescript
import type { MemoryStore } from '../memory/types';
```

```typescript
  constructor(
    private readonly store: TranscriptStore,
    private readonly providers: Map<string, AgentProvider>,
    private readonly emit: (msg: HostToWebview) => void,
    private readonly contextTimeoutMs = 5000,
    private readonly onShellNoise: (profile: string) => void = () => {},
    private readonly attachments?: AttachmentStore,
    private readonly defaultFileCap: number = FILE_CAP,
    private readonly extraBaseRefs: string[] = [],
    /**
     * Indexes a session's transcript into the swappable memory backend the
     * moment it archives. Optional: a construction site with no memory
     * store simply never indexes, the same posture `attachments` already
     * takes for a missing `AttachmentStore`.
     */
    private readonly memory?: MemoryStore,
  ) {}
```

Then in `archive()`:

```typescript
  private async archive(id: SessionId): Promise<void> {
    this.queuedMoves.delete(id);
    const session = this.live.get(id);
    if (session) {
      await session.dispose();
      this.live.delete(id);
    }
    const state = this.meta.get(id);
    if (state) {
      state.archived = true;
      state.status = 'idle';
      state.updatedAt = Date.now();
      void this.indexForMemory(id, state);
    }
    this.visible.delete(id);
    this.changed();
  }

  /**
   * Fire-and-forget, same posture as `schedulePersist()`: a memory-store
   * failure must never surface as a rejection out of `archive()`/`close()`/
   * `remove()`, and `memory.sqlite` (or whatever a future implementation
   * uses) is a rebuildable cache, never a reason to fail a session lifecycle
   * transition. Skips a bare untitled/empty session — same emptiness check
   * `isDiscardable` uses — since there is nothing there worth finding later.
   */
  private async indexForMemory(id: SessionId, state: SessionState): Promise<void> {
    if (!this.memory || state.title === 'Untitled') { return; }
    try {
      const { items } = await this.store.tail(id, Number.MAX_SAFE_INTEGER);
      if (items.length === 0) { return; }
      await this.memory.index({
        sessionId: id, providerId: state.providerId, cwd: state.cwd,
        title: state.title, closedAt: state.updatedAt, items,
      });
    } catch (err) {
      console.error('[mar-code] memory indexing failed', err);
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:unit --grep "SessionManager memory indexing"`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full unit suite to check for regressions**

Run: `yarn test:unit`
Expected: PASS — every existing `new SessionManager(...)` call site keeps working because
`memory` is trailing and optional.

- [ ] **Step 6: Commit**

```bash
git add src/host/session-manager.ts src/test/unit/session-manager-memory.test.ts
git commit -m "feat: index sessions into MemoryStore on archive"
```

---

### Task 6: `marcode__recall` / `marcode__recall_fetch` tools

**Files:**
- Modify: `src/host/self-control-mcp-server.ts`
- Modify: `src/test/unit/self-control-mcp-server.test.ts`

**Interfaces:**
- Consumes: `MemoryStore`, `MemoryHit` (Task 1).
- Produces: `SelfControlMcpServer`'s constructor gains a trailing optional
  `memory?: MemoryStore` second parameter. Two new tools registered in `buildMcpServer()`.

- [ ] **Step 1: Write the failing tests**

Add to `src/test/unit/self-control-mcp-server.test.ts`, near the top (after `fakeManager`):
a `callTool` helper factoring out the JSON-RPC POST shape every existing test in this file
already repeats inline, plus a `fakeMemory` helper and the new suite:

```typescript
import type { MemoryHit, MemoryStore } from '../../memory/types';
import type { SelfControlMcpConfig } from '../../providers/types';

async function callTool(
  config: SelfControlMcpConfig, name: string, args: Record<string, unknown>,
): Promise<{ isError?: boolean; content: { type: string; text: string }[] }> {
  const res = await fetch(config.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = await res.json() as { result: { isError?: boolean; content: { type: string; text: string }[] } };
  return body.result;
}

function fakeMemory(overrides: Partial<MemoryStore> = {}): MemoryStore {
  return {
    search: async () => [],
    fetch: async () => ({ sessionId: 's1', items: [] }),
    index: async () => {},
    ...overrides,
  };
}

suite('SelfControlMcpServer memory tools', () => {
  test('marcode__recall returns snippets from MemoryStore.search()', async () => {
    const hit: MemoryHit = { sessionId: 's1', itemId: 'u1', snippet: 'Fixed the flaky login test', score: 1, ts: 1000 };
    const memory = fakeMemory({ search: async (query) => { assert.strictEqual(query, 'login'); return [hit]; } });
    const server = new SelfControlMcpServer(fakeManager(), memory);
    const config = await server.start();
    const result = await callTool(config, 'marcode__recall', { query: 'login' });
    assert.deepStrictEqual(JSON.parse(result.content[0].text), [hit]);
    await server.dispose();
  });

  test('marcode__recall_fetch returns MemoryStore.fetch()\'s slice', async () => {
    const memory = fakeMemory({
      fetch: async (hit) => {
        assert.strictEqual(hit.sessionId, 's1');
        assert.strictEqual(hit.itemId, 'u1');
        return { sessionId: 's1', items: [{ id: 'u1', ts: 0, role: 'user', text: 'hi' }] };
      },
    });
    const server = new SelfControlMcpServer(fakeManager(), memory);
    const config = await server.start();
    const result = await callTool(config, 'marcode__recall_fetch', { sessionId: 's1', itemId: 'u1' });
    const body = JSON.parse(result.content[0].text) as { items: unknown[] };
    assert.strictEqual(body.items.length, 1);
    await server.dispose();
  });

  test('marcode__recall errors without a MemoryStore configured', async () => {
    const server = new SelfControlMcpServer(fakeManager());
    const config = await server.start();
    const result = await callTool(config, 'marcode__recall', { query: 'login' });
    assert.strictEqual(result.isError, true);
    await server.dispose();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit --grep "SelfControlMcpServer memory tools"`
Expected: FAIL — `SelfControlMcpServer` constructor does not accept a second argument
(TypeScript error), or the tool is unknown once that compiles.

- [ ] **Step 3: Implement**

In `src/host/self-control-mcp-server.ts`:

```typescript
import type { MemoryStore } from '../memory/types';
```

```typescript
export class SelfControlMcpServer {
  private http: Server | undefined;
  private readonly token = randomBytes(24).toString('hex');

  constructor(
    private readonly sessionManager: SessionManagerLike,
    private readonly memory?: MemoryStore,
  ) {}
```

In `buildMcpServer()`, after the existing `marcode__spawn_session` registration:

```typescript
    mcp.registerTool(
      'marcode__recall',
      {
        title: 'Search past Marcode sessions',
        description: 'Searches this workspace\'s closed Marcode sessions for a keyword or '
          + 'phrase. Returns short snippets, not full transcripts — call marcode__recall_fetch '
          + 'on a specific result to read more.',
        inputSchema: {
          query: z.string().describe('Keywords to search for.'),
          providerId: z.string().optional().describe('Restrict to one provider, e.g. "claude".'),
          limit: z.number().optional().describe('Max results. Defaults to 20.'),
        },
      },
      async ({ query, providerId, limit }) => {
        if (!this.memory) {
          return { isError: true, content: [{ type: 'text', text: 'Memory search is unavailable in this window.' }] };
        }
        const hits = await this.memory.search(query, { providerId, limit });
        return { content: [{ type: 'text', text: JSON.stringify(hits) }] };
      },
    );

    mcp.registerTool(
      'marcode__recall_fetch',
      {
        title: 'Fetch a past session\'s transcript slice',
        description: 'Reads a bounded slice of one past session\'s transcript, anchored at a '
          + 'result from marcode__recall. Never call this speculatively — call marcode__recall first.',
        inputSchema: {
          sessionId: z.string().describe('A sessionId from a marcode__recall result.'),
          itemId: z.string().describe('The itemId from that same result.'),
        },
      },
      async ({ sessionId, itemId }) => {
        if (!this.memory) {
          return { isError: true, content: [{ type: 'text', text: 'Memory search is unavailable in this window.' }] };
        }
        const detail = await this.memory.fetch({ sessionId, itemId });
        return { content: [{ type: 'text', text: JSON.stringify(detail) }] };
      },
    );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit --grep "SelfControlMcpServer"`
Expected: PASS, all tests in this file including the pre-existing spawn_session ones.

- [ ] **Step 5: Commit**

```bash
git add src/host/self-control-mcp-server.ts src/test/unit/self-control-mcp-server.test.ts
git commit -m "feat: add marcode__recall and marcode__recall_fetch MCP tools"
```

---

### Task 7: Wire it all up in `extension.ts`

**Files:**
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: `FtsMemoryStore`, `ExtractiveSummarizer` (Tasks 2–3), the updated
  `SessionManager` and `SelfControlMcpServer` constructors (Tasks 5–6).

- [ ] **Step 1: Construct the store and thread it through**

In `src/extension.ts`, alongside the existing `store`/`attachments` construction near the
top of `activate()`:

```typescript
import { ExtractiveSummarizer } from './memory/extractive-summarizer';
import { FtsMemoryStore } from './memory/fts-memory-store';
```

```typescript
  const rootDir = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
  const store = new TranscriptStore(rootDir);
  const attachments = new AttachmentStore(rootDir);
  const memory = new FtsMemoryStore(
    path.join(rootDir, 'memory.sqlite'),
    new ExtractiveSummarizer(),
    { tail: (id, limit) => store.tail(id, limit) },
  );
```

Confirm `path` is already imported in this file (`import * as path from 'path';` or
similar) before adding this — if not, add it alongside the other node imports at the top.

Update the `SessionManager` construction to pass `memory` as the trailing argument, keeping
every existing positional argument unchanged:

```typescript
  const manager = new SessionManager(
    store, providers, (msg) => bus.post(msg), undefined, warnAboutProfile, attachments,
    reviewFileCap(), reviewBaseRefs(), memory,
  );
```

Update the `SelfControlMcpServer` construction to pass `memory` as its second argument:

```typescript
  const selfControlServer = new SelfControlMcpServer({
    catalog: () => manager.catalog(),
    create: (providerId, cwd, model, effort, mode) => manager.create(providerId, cwd, model, effort, mode),
  }, memory);
```

- [ ] **Step 2: Type-check and lint**

Run: `yarn check-types && yarn lint`
Expected: both pass.

- [ ] **Step 3: Full compile and unit suite**

Run: `yarn run compile && yarn test:unit`
Expected: both pass — this is the point where a missing `path` import or a positional-arg
mismatch would surface as a compile error.

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "feat: wire FtsMemoryStore into SessionManager and self-control MCP server"
```

---

## Follow-up (separate plan, not this one)

- Browse/search UI in the review tab (`src/review/`): search box, hit list, read-only
  transcript-slice viewer — calls into the same `MemoryStore` this plan builds, through
  `ReviewPanel`'s own `MessageRouter`. Needs an `impeccable` pass per `CLAUDE.md`'s UI
  gate, which this backend-only plan has nothing for.
- A real integration test exercising `marcode__recall` end-to-end against a Claude Agent
  SDK session (this plan's tests use fakes throughout, matching the existing
  `self-control-mcp-server.test.ts` precedent).
