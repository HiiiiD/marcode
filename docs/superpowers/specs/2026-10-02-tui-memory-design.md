# TUI memory (roadmap item F, memory half)

Written 2026-10-02. Login-by-suspending-the-renderer is the other half of F and is not covered here.

## Goal

The terminal client has the same memory as the VS Code panel: recall tools, priming, and digests of hidden
sessions, over the same `memory.sqlite`.

Success:

- A TUI session can call `marcode__recall` and is primed with earlier sessions.
- A session digested by a VS Code host is recallable from the TUI, and the reverse.
- With only the TUI open, the TUI claims the `digest` lock and runs the configured LLM summarizer.
- VS Code behavior is unchanged.

## Problem

Under Bun `node:sqlite` does not exist, so `src/memory/fts-memory-store.ts` cannot load. The TUI therefore
forces `memory.enabled = false` (`memoryForRuntime` in `src/tui/boot.ts`, decided in
`docs/superpowers/notes/2026-10-01-bun-host-spike.md`). Everything else memory needs already lives in
`createHost` and runs under Bun: `DigestService` (imports only `memory/*` and `protocol`), the `digest`
lock via `SessionOwnership`, the summarizer chain, priming and the recall tools.

## Approach

Add a driver seam under the store and use `bun:sqlite` under Bun. The schema and queries do not change, so
both hosts read and write one file (WAL, `busy_timeout = 5000`).

Rejected: a pure-JS index (new on-disk format both hosts would have to read or migrate) and a Node child
process owning the store (IPC for no gain).

## Design

### Driver seam

`src/memory/sqlite-driver.ts` exports `openDatabase(path): SqlDb`.

`SqlDb` is the surface the store uses: `exec(sql)`, `prepare(sql)` returning `{ get, all, run }`, and
`close()`. The module chooses `bun:sqlite` when `process.versions.bun` is defined and `node:sqlite`
otherwise, through a lazy `require` inside `openDatabase` (not a top-level import), so a missing module
throws at open time and lands in `createHost`'s existing catch.

A thin wrapper normalizes the differences between the drivers:

- `get()` returns `null` under `bun:sqlite` and `undefined` under `node:sqlite` for no row; the wrapper
  returns `undefined`.
- Parameter binding: the wrapper passes positional parameters the way each driver accepts them.

`openDatabase` runs an FTS5 probe (create and drop a temporary `fts5` table) and throws a clear error if it
fails, so a build without FTS5 (the macOS system SQLite is the known risk) is an explicit failure, not a
later query error.

`FtsMemoryStore` keeps its constructor signature, `(path, reader)`. It calls `openDatabase(path)` instead of
`new DatabaseSync(path)`. Queries, schema and the schema-version reset are untouched.

### TUI wiring

- Delete `memoryForRuntime` and its call in `src/tui/boot.ts`. `config.memory` passes through, so memory
  follows `config.json` as in VS Code.
- `subcommands.ts` keeps `memory: { enabled: false }`: short-lived commands must not open the store or claim
  the digest lock.
- `createHost` is otherwise unchanged. The TUI adds no memory code.

### Failure handling

If the driver cannot load or FTS5 is missing, `createHost` still runs with memory off. Its catch now calls
`notify.warn` as well as `console.warn`, because `console.warn` is invisible under the OpenTUI console
overlay. `notify` is already in scope there (`opts.notify`). VS Code shows the same warning.

### Lock and sharing

Unchanged. The TUI and VS Code both try to claim `digest`; one host runs the LLM summarizer and the other
writes extractive digests, which are idempotent. Concurrent writers are covered by WAL and `busy_timeout`.

## Testing

- Existing `src/test/unit/fts-memory-store.test.ts` keeps running under Node (`node:sqlite`).
- `src/test/tui/` gains a `bun test` suite running the store through `bun:sqlite`: index, recall with the
  folder-scope filter, delete, schema-version reset, and the `null` versus `undefined` normalization.
- Cross-driver: Node writes a database and Bun reads it, and the reverse. Both hosts share one file, so this
  is the test that matters.
- FTS5 probe: opening fails with the clear error when FTS5 is unavailable (driver stubbed).
- `tui-boot.test.ts`: remove the two `memoryForRuntime` tests; add one that `bootHost` under Bun passes
  `memory.enabled` through.
- `createHost`: the unavailable-store catch calls `notify.warn`.
- TUI assertions follow `scripts/check-tui-asserts.mjs`: no renderer or renderable in an assertion.

## Manual verification

Build `bin/marcode` with `yarn build:tui:bin`. Close a session, then call `marcode__recall` from a second
one. Confirm the same session is recallable from a VS Code host on the same workspace. Verify the compiled
binary resolves `bun:sqlite`.

Not verified, and recorded in `docs/tui.md` once built: macOS system SQLite and FTS5.

## Out of scope

- Changes to the digest format or recall ranking.
- A memory UI in the TUI.
- Replacing the sqlite store.
- In-TUI login (the other half of F).
