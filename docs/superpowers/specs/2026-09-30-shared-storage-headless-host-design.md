# Shared storage and a vscode-free host

Sub-project 1 of the Marcode TUI. The OpenTUI client is a separate spec that builds on this one.

## Goal

A terminal-native user can run Marcode's host without VS Code, and sessions are shared with any
VS Code window on the same workspace. Success: two host processes on one workspace see one
roster, each session is run by exactly one of them, and the other shows it live and read-only.

## Decisions

- **No daemon.** Each client (VS Code extension, later the TUI) keeps its own in-process host.
  They share files, not live state. A daemon stays possible later because the core is already
  vscode-free.
- **Storage moves to `~/.marcode/`** (`MARCODE_HOME` overrides), one folder per workspace.
- **One session, one owner**, tracked by a lease file. A session owned elsewhere is read-only.
- **`config.json` is the single source of truth** for host settings.

## Storage layout

```
~/.marcode/
  config.json
  workspaces/
    <slug>/
      workspace.json      { "path": "<real workspace path>" }
      index.json          roster, layout, visible set
      catalog.json
      memory.sqlite
      digest.lock
      migrated.json       { "from": "<old storageUri>", "at": "<iso>", "declined"?: true }
      sessions/
        <id>.jsonl
        <id>.lock         { "pid", "host": "vscode" | "tui", "heartbeat" }
```

### Workspace resolver

`src/shared/workspace-dir.ts`, pure, no `vscode` import.

1. Normalize the path: real path, drive letter lowercased, trailing separators stripped, case
   folded on Windows and macOS.
2. Slug: every non-alphanumeric character becomes `-` (`e:\Efebia\x` → `e--Efebia-x`).
3. A slug over ~80 characters is truncated and given a short hash suffix (MAX_PATH).
4. If `workspace.json` in the slug folder names a different path, use a numbered suffix (`-2`).
   The `-2` folder is verified the same way.

Callers: the extension passes the first workspace folder; the TUI passes its cwd, or the git
root when there is one. A VS Code window with no folder uses `workspaces/_global/`.

## Config

`~/.marcode/config.json` holds the settings the host consumes: `enabledProviders`,
`memory.enabled`, `memory.summarizer`. Global, no per-workspace override. Pure-UI settings stay
in VS Code.

- The extension removes those three `contributes.configuration` entries and adds
  `marcode.config.open`.
- A file watcher keeps the existing "changed, reload the window" prompt.
- `createHost` loads the file itself; the extension passes nothing settings-related.
- The first import (below) copies existing VS Code values into `config.json` when it does not
  exist yet.

## Session ownership

`sessions/<id>.lock` is JSON `{ pid, host, heartbeat }`.

- Created with the `wx` flag, so two hosts racing for a session cannot both win.
- The owner rewrites `heartbeat` every 5s (temp file + rename) and deletes the file on close or
  shutdown.
- **Stale** when the heartbeat is older than 20s, or when the pid is dead and the lease was
  written on this machine (`process.kill(pid, 0)`).
- **Takeover of a stale lease:** delete the file, retry `wx`. Exactly one racer wins.

Host view of a session:

| State | Meaning | Behavior |
|---|---|---|
| `owned` | this host holds the lease | runs the provider (today's behavior) |
| `foreign` | another live host holds it | read-only tail, composer and approvals disabled |
| `free` | no lease, or a stale one | claimed on create or resume |

A `foreign` session tails `sessions/<id>.jsonl` with `fs.watch` plus a re-read from the last
offset. Its status label reads "running in vscode (pid N)". Closing it in the UI only hides it
locally and never touches the owner's lease. No forced takeover of a live lease in this spec.

`SessionState` gains `owner?: { host, pid }`, set only when foreign. Additive; every message
keeps its explicit `SessionId`.

### Roster and derived stores

- `index.json` is written atomically (temp file + rename) and watched. On an external change the
  host merges in sessions it does not own and never overwrites an owned entry from disk.
- `memory.sqlite`: a single writer via `digest.lock`, held by whichever host starts first. The
  other host does recall reads only (WAL mode).
- A failed lease write or unreadable lock file is session state (`error` plus a transcript item),
  never an exception.

## Migration

`src/host/migrate-storage.ts`, no `vscode` import. Input: the old `storageUri` path and the
resolved workspace dir.

- **Trigger:** on activation, when the workspace dir has no `migrated.json` and the old dir has
  an `index.json`, the extension asks "Import N sessions into ~/.marcode?". Declining writes
  `migrated.json` with `declined: true`.
- **Copy, never move.** `index.json`, `catalog.json`, `memory.sqlite`, `sessions/*.jsonl`, each
  through a temp name and a rename. The old dir is never modified.
- **Failure:** stop at the first error, remove the partial files it created, report it as state,
  write no `migrated.json`, so it can be retried.
- Also exposed as `marcode migrate <old-dir>` for the terminal side; same function.
- **Rollback:** the old dir is intact, so downgrading the extension works. Sessions created after
  migration exist only in the new location.

## Code changes

- `createHost({ workspaceDir, cwd }) → { manager, dispose }`: the wiring now in `activate()`,
  with no `vscode` types. It loads `config.json` itself.
- `extension.ts` shrinks to resolving the workspace dir, calling `createHost`, running the
  migration prompt and registering panels.
- Four `storageUri` leaks become constructor parameters: `transcript-store.ts`, `default-cwd.ts`,
  `question-persistence.ts`, and the mention in `providers/types.ts`.
- New modules: `src/shared/workspace-dir.ts`, `src/host/lease.ts`, `src/host/migrate-storage.ts`,
  `src/host/foreign-tail.ts`, `src/host/config-file.ts`.

## Testing

Unit (mocha, `tsx`):

- Resolver: separators, drive letters, case folding, long paths, collision suffix.
- Lease: exclusive create, heartbeat, stale by time, stale by dead pid, a two-claimant race.
- Migration: success, mid-copy failure with cleanup, re-run after `migrated.json`, declined marker.
- Config: first-import copy from VS Code settings, missing file, invalid file as state.
- `index.json` merge: a foreign change never overwrites an owned entry.
- Foreign tail: appended JSONL lines produce patches.

Integration: two `createHost` instances in one process on one temp `MARCODE_HOME` with
`FakeProvider`. One owns a session; the other sees it `foreign` and receives its transcript. The
existing extension integration test swaps `storageUri` for a temp `MARCODE_HOME`.

## Out of scope

The OpenTUI client, forced takeover of a live lease, cross-host control (the daemon), per-workspace
config overrides.

## Invariants kept

- `src/protocol/messages.ts` stays types-only; `owner` is a type addition.
- Nothing under `src/providers/` or `src/protocol/` imports `vscode`, and neither do the new host
  modules.
- Errors are state, never exceptions.
- The extension host remains the owner of all state within its own process; the webview is
  unchanged as a rendering client.
