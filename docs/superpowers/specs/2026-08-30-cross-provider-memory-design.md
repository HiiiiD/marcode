# Cross-provider memory — design

## Scope

Let a Marcode session recall content from earlier Marcode sessions — same or different
provider (Claude SDK, ACP backends, OpenCode) — without loading full transcripts into
context. Two consumers: an agent-callable recall tool, and a human browse/search surface.

v1 covers only sessions Marcode itself created and transcribed (`TranscriptStore`'s JSONL).
Reading another tool's own history (Claude Code's project transcripts, Codex CLI's session
logs, etc.) is out of scope — a different data source with its own format per vendor, not
designed here.

The retrieval *algorithm* — how a session gets indexed and how a query is scored — is
designed to be swappable without touching either consumer. v1 ships one keyword-based
implementation; a future semantic/embedding implementation is a new class behind the same
interface, not a rewrite.

Out of scope for v1: semantic (embedding) search, cross-machine sync, reading
non-Marcode session formats, a settings UI for choosing the store implementation (one
implementation ships; the seam exists, the picker doesn't yet).

## Components

- **`src/memory/types.ts`** (new). Types-only, no `vscode` import — the same boundary rule
  as `src/protocol/messages.ts` and `src/providers/types.ts`. Declares the `MemoryStore`
  interface and its data shapes:

  ```ts
  export interface MemoryHit {
    sessionId: SessionId;
    itemId: string;       // anchors fetch() to a point in that session's transcript
    snippet: string;       // short, already cheap to read — never a token cost concern
    score: number;
    ts: number;
  }

  export interface MemoryDetail {
    sessionId: SessionId;
    items: TranscriptItem[];   // a bounded slice around the hit, not the whole transcript
  }

  export interface SessionRecord {
    sessionId: SessionId;
    providerId: string;
    cwd: string;
    title?: string;
    closedAt: number;
  }

  export interface MemoryStore {
    /** Called once a session goes idle/closes. Reads its JSONL, writes whatever this
     *  implementation needs to make it findable later. Never called on a live session. */
    index(record: SessionRecord): Promise<void>;
    /** Cheap: returns snippets, not full content. This is the token-efficiency seam —
     *  a caller reads `MemoryHit[]` before ever paying for `fetch()`. */
    search(query: string, opts?: { providerId?: string; limit?: number }): Promise<MemoryHit[]>;
    /** Full slice for exactly one hit, on demand. */
    fetch(hit: MemoryHit): Promise<MemoryDetail>;
  }
  ```

- **`src/memory/fts-memory-store.ts`** (new). v1's only implementation. Built on
  `node:sqlite` (stable in Node 22, this project's extension-host target — no new
  dependency) with an FTS5 virtual table, file `memory.sqlite` under `context.storageUri`,
  alongside
  `index.json`/`sessions/*.jsonl`. `index()` extracts a short summary (see below) plus raw
  searchable text (user/assistant turns, tool call summaries) and upserts one FTS row per
  session. `search()` queries FTS5, returns ranked snippets. `fetch()` reads the named
  session's JSONL via `TranscriptStore` and slices around `itemId`.

- **Summary generation.** `index()` needs a short natural-language summary for
  browse-surface display and for search relevance beyond raw keyword text. This is a
  small, separate concern the store delegates to rather than owns:

  ```ts
  export interface Summarizer {
    summarize(items: TranscriptItem[]): Promise<string>;
  }
  ```

  `FtsMemoryStore` takes a `Summarizer` in its constructor. v1's `Summarizer` is a cheap
  extractive one (first user message + session title + counts) — no LLM call, no added
  cost or latency on session close. An LLM-backed summarizer is a valid future
  implementation of the same one-method interface, swappable independently of the store.

- **An addition to `src/host/self-control-mcp-server.ts`**, not a second server: it already
  gives every session's provider one loopback MCP endpoint, and a second tool avoids a
  second bearer-token/port pair for no benefit. Two new tools:
  - `marcode__recall(query, providerId?, limit?)` → calls `MemoryStore.search()`, returns
    hits (snippets + ids) as tool output. Cheap by construction — snippets, never full
    transcript content.
  - `marcode__recall_fetch(sessionId, itemId)` → calls `MemoryStore.fetch()`, returns the
    bounded slice for one specific hit the agent already decided is worth the tokens.
  Splitting recall into two tool calls is the whole token-efficiency mechanism on the agent
  side: an agent that only ever calls `marcode__recall` never pays for a full slice.

- **`SessionManager`**: owns the single `MemoryStore` instance (constructed in
  `extension.ts`, same wiring pattern as `TranscriptStore`), calls `store.index(record)`
  when a session's status transitions to idle/closed and its transcript is flushed.
  Indexing failure is logged, never thrown — a memory-store outage must not affect the
  session it was trying to index (same "errors are state" spirit, though this isn't a
  transcript item since it's not a live turn).

- **Browse/search UI**: a new tab in the review surface (`ReviewPanel`), not the sidebar —
  it's read-only, orthogonal to the roster, and the review tab already exists as a second
  client with its own narrow state (`src/review/`) rather than `ClientState`/
  `session-patch`, which is exactly the shape this needs: a search box, a hit list, and a
  read-only transcript-slice view, none of it wired into pane layout or the composer.
  Sends a search request through `ReviewPanel`'s own `MessageRouter`, gets back
  `MemoryHit[]`, renders snippets; selecting one requests `fetch()` for the full slice,
  rendered read-only.

## Data flow

1. A session closes or goes idle. `SessionManager` builds a `SessionRecord` and calls
   `store.index(record)`.
2. `FtsMemoryStore.index()` reads that session's JSONL via the existing `TranscriptStore`,
   asks its `Summarizer` for a short summary, and upserts an FTS5 row (summary + searchable
   text + metadata).
3. **Agent path**: a live session calls `marcode__recall` → handler calls
   `store.search(query)` → returns snippets only. If the agent wants more, it calls
   `marcode__recall_fetch` for one specific hit → `store.fetch()`. Two tool round-trips,
   never a whole transcript, by construction.
4. **Human path**: review tab sends a search request → its `MessageRouter` calls
   `store.search()` → renders hit list → user opens one → `store.fetch()` → renders the
   slice.

## Modularity / swap story

- Every consumer (MCP tool handler, browse UI's host-side handler) depends only on
  `MemoryStore`, never on SQLite or FTS5 directly — mirrors `AgentSession` depending on
  `AgentProvider`, never on the Claude SDK or ACP wire types.
- JSONL transcripts remain the single source of truth. `memory.sqlite` (or whatever a
  future implementation's own storage is) is a **rebuildable cache**, exactly the same
  status `catalog.json`/`seededModels` hold for model lists: authoritative only until the
  real source re-answers, never persisted past that. Swapping `FtsMemoryStore` for, say, a
  future `VectorMemoryStore` means: implement `MemoryStore`, flip a setting, re-index every
  session from JSONL on first use (or lazily, on first miss) — no migration code, because
  there is nothing to migrate: the old store's on-disk file is simply abandoned, the same
  way `TranscriptStore` abandons old-version JSONL files rather than upgrading them in
  place.
- `Summarizer` is a second, independently swappable seam nested inside the store — v1's
  extractive summarizer can become an LLM-backed one later without changing
  `MemoryStore`'s contract, `search()`'s token cost, or any consumer.

## Error handling

- `index()` failures: logged, swallowed. A session that fails to index is simply not
  findable later — not a reason to fail the close/idle transition it's hooked to.
- `search()`/`fetch()` failures (e.g. corrupt `memory.sqlite`): return empty results rather
  than throwing, both to the MCP tool (tool error content, `isError: true`, not an
  exception — same pattern as `self-control-mcp-server.ts`) and to the browse UI (empty
  state, not a crash).
- A `fetch()` for a hit whose session's JSONL has since been deleted (`TranscriptStore.remove`
  ran after indexing): returns an empty `MemoryDetail`, same "answers a question, never
  throws" contract `TranscriptStore.find` already follows.

## Testing

- Unit test `FtsMemoryStore` directly against a temp SQLite file: index a few synthetic
  `SessionRecord`s + their JSONL, assert `search()` ranks relevantly, assert `fetch()`
  returns a bounded slice around the right `itemId`.
- Unit test the MCP tool handler as a pure function against a fake `MemoryStore` — same
  shape as the existing self-control handler tests.
- One test asserting `MemoryStore` is the only type either the MCP handler or the browse
  UI's host-side handler imports from `src/memory/` — guards the modularity seam the way
  "no `vscode` import" is guarded elsewhere (a grep-based check is enough; no need for
  tooling beyond what the codebase already does for its other import-boundary rules).

## Deferred (not this spec)

- Semantic/embedding search implementation (a second `MemoryStore`).
- Reading non-Marcode session formats (Claude Code CLI, Codex CLI, Cursor, etc.).
- Settings UI for choosing between store implementations.
- Cross-machine/sync concerns.
- Automatic re-indexing on a schedule (v1 indexes once, at close/idle, and never touches a
  session again unless it's explicitly re-opened and re-closed).
