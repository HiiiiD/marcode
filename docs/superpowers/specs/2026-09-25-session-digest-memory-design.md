# Session digest memory

Status: draft for review. Supersedes the raw-prompt snippet in `FtsMemoryStore` and the
separate `SessionState.summary` cache.

## Intent

Agents should benefit from past sessions without being told to search, and without paying
a large token cost for it. Recall today needs an explicit instruction, and what it returns
is the first 200 characters of a session's first prompt, which says what a session was
about but not what it concluded.

Success looks like:

- A fresh session's first message carries a few one-line pointers to related past sessions
  (about 25 tokens each), and the agent fetches detail only when a pointer looks relevant.
- Each past session has one structured digest, and the history tab and recall read the same
  record.
- An LLM-written digest is available, off by default, on a provider, model and effort the
  user chooses. Extractive digests work with no model cost.
- Hundreds of existing sessions can be indexed, and any one can be re-summarized.

Assumptions (correct me): summaries run on session close, not per tool call; a hidden agent
run is acceptable as the LLM transport because no provider offers a one-shot completion.

## Non-goals

Per-tool-call observation capture (claude-mem's observer). Transcripts already hold the raw
events, and the observer is what costs claude-mem money and latency. Embeddings or semantic
search. Injection on `compact` or `clear`. File-touch injection, which needs a pre-tool hook
that ACP and Codex do not expose.

## Current state

| | History tab | Memory store |
|---|---|---|
| Field | `SessionState.summary {text, forUpdatedAt}` | `sessions_fts.summary` |
| Writer | `SessionManager.runSummaries` via `digestSession` | `FtsMemoryStore.index` via `ExtractiveSummarizer` |
| Trigger | history tab opens; stale when `forUpdatedAt !== updatedAt` | session archives |
| Covers | every non-Untitled session | closed sessions only |

Two writers, two shapes, two triggers. Delivery of memory to a new session is already in
place (`AgentSession.deliver` calls `sink.recall` for a fresh first message; commit
`3310b1e`) and is independent of what the store holds.

## Design

### One record, one writer

A `SessionDigest` is the single source. Fields:

- `title`, `request`, `outcome`, `filesEdited: string[]`
- `learned`, `decisions`, `nextSteps` (LLM digests only; absent on extractive ones)
- `source: 'extractive' | 'llm'`, `summarizerVersion: number`, `forUpdatedAt: number`

`indexLine(digest)` derives the one-line pointer (`title → outcome · N files`). The FTS row is
built from the digest: `title`, `indexLine`, and the searchable text.

A `DigestService` (folder `src/host/digest/`, service plus helpers) is the only writer. It
owns a serial queue (concurrency 1). Nothing else assigns a digest.

### Storage

A `digests` table beside `sessions_fts` in `memory.sqlite`, keyed by `sessionId`. It is a
rebuildable cache: JSONL stays the source of truth. `SCHEMA_VERSION` bumps and the rebuild is
the reindex path below, so a version bump no longer leaves an empty index.

`SessionState.summary` remains on the wire as `{ text, forUpdatedAt }` because the history
client already consumes it, but it becomes a projection of the digest, never independently
written. `ensureSummaries()` is replaced by the service's extractive pass. Writing a digest
never touches `updatedAt` (existing invariant: it is the history sort key and the cache key).

### Settings

`marcode.memory.enabled` (boolean, default `true`). Some users already run a memory plugin,
and two systems competing to inject context is worse than one. When `false`, none of this
runs: no store is opened, no FTS indexing, no first-message priming, no LLM summarizer, no
reindex, and the `marcode__recall`/`marcode__recall_fetch` tools are not registered (so their
MCP instructions do not mention them either). The history tab is unaffected: it keeps its
existing in-memory extractive `SessionState.summary`, filled as it is today. A change prompts
a window reload, like `marcode.enabledProviders`.

Because the recall nudge must not appear when memory is off, it moves out of the always-on
`MARCODE_INTRO` and into the self-control MCP `instructions` text, which is only built when a
memory store exists.

`marcode.memory.summarizer`:

```json
{ "mode": "off", "provider": "claude", "model": "claude-haiku-4-5", "effort": "low" }
```

`mode` defaults to `off`. `provider`, `model` and `effort` are read only when `mode` is
`llm`. `provider` and `model` are required: there is no default model, because picking one
on the user's behalf would spend their quota on a choice they never made. `effort` is
optional and defaults to `low`. Validated like `marcode.systemPrompts`: `llm` with a missing
or unknown `provider`/`model` warns once and falls back to `off`. Registration is read at
activate and a change prompts a reload, matching `marcode.enabledProviders`.

### LLM summarizer

Providers run agent sessions, not completions, so the summarizer starts a hidden run through
`provider.start`, sends one prompt, collects the text and disposes the run.

- Never an `AgentSession`: it is not in the roster, not visible, not indexed, and cannot
  produce a digest of itself.
- Tool-less and read-only. It must not reach `marcode__recall` (a recursion risk) or any
  self-control tool. The self-control MCP config is bound at provider construction today, so
  the plan must add a `StartOptions` flag that omits it for this run.
- Input is a trimmed digest of the transcript: user prompts, each turn's final assistant
  text and the edited-file list. Tool output is dropped. Capped at about 4k tokens.
- Output is JSON in the `SessionDigest` shape. A parse failure, timeout (90s), missing
  provider or auth error records the extractive digest instead and logs. Errors are state.

### Recall tiers

1. **Pointer** (`indexLine`, about 25 tokens): what `marcode__recall` returns and what
   priming injects.
2. **Digest**: `marcode__recall_fetch` with `detail: 'digest'` (default) returns the full
   record.
3. **Transcript slice**: `detail: 'transcript'`, today's behaviour.

`buildMemoryBlock` renders pointers from `indexLine`. The score floor (currently 2.5,
measured on raw-prompt text) is retuned against digest text in the plan.

### Reindex and re-summarize

- Pass 1, always free: rebuild every session's extractive digest and FTS row from JSONL, so
  all sessions are findable immediately.
- Pass 2, only when `mode` is `llm`: upgrade closed sessions to LLM digests in the
  background, newest first. A session that is still open keeps its extractive digest until
  it closes; LLM digests are never produced for a live session.
- Entry points: command `marcode.memory.reindex`, a per-row "Re-summarize" in the history
  tab, and a bulk history-tab action with scope `all` or `missing-llm`.
- Before pass 2, show a cost estimate (session count and roughly 3k input tokens each) and
  require confirmation.
- Progress is reported and cancellable. It resumes on re-run because a session is skipped
  when its digest's `source`, `summarizerVersion` and `forUpdatedAt` are current. A failed
  session is logged and skipped; the run continues.

### Protocol

Types only in `src/protocol/messages.ts`. History to host: `memory-reindex { scope }` and
`memory-resummarize { id }` (explicit `SessionId`). Host to history: `memory-progress
{ done, total, phase }`. Neither is added to `REVIEW_WANTS`; `HISTORY_WANTS` gains
`memory-progress`.

## Testing

- `DigestService`: queue serialization, extractive fallback on each failure mode, `updatedAt`
  untouched, skip-if-current resume.
- Extractive digest and `indexLine` as pure functions.
- Store: rebuild after a schema-version bump; FTS row derived from the digest.
- Hidden run: no roster entry, no MCP, disposed on success and failure.
- History DOM tests through the real `StoreProvider`, asserting posted messages.
- Priming block rendered from pointers; score floor against realistic digests.

## Decisions

- The summarizer's `model` must be set in config; there is no automatic cheapest-model pick.
- Only closed sessions receive an LLM digest.
