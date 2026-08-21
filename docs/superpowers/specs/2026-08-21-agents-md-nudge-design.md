# AGENTS.md / CLAUDE.md migration nudge — design

**Date:** 2026-08-21
**Status:** approved, not implemented

## Why

Repos in the wild carry agent instructions under either `CLAUDE.md` (Claude-specific) or
`AGENTS.md` (cross-vendor, growing convention; Claude Code also reads it via `@AGENTS.md`
imports). A workspace that has drifted to only one format is either invisible to non-Claude
providers (`AGENTS.md`-only repos read by nothing but Claude) or locks its instructions to
one vendor (`CLAUDE.md`-only). Marcode runs multiple providers side by side, so it is
positioned to notice the gap and offer a one-click fix.

## Rule

`AGENTS.md` is the source of truth. `CLAUDE.md`, when present, is never real content — it is
a one-line stub: `@AGENTS.md`. Two divergent states are worth flagging, per directory:

- **Case 1 — migrate:** `CLAUDE.md` has real content, no sibling `AGENTS.md`. Action: move
  the content to a new `AGENTS.md`, overwrite `CLAUDE.md` with the stub.
- **Case 2 — add-stub:** `AGENTS.md` exists, no sibling `CLAUDE.md`, and the `claude`
  provider is enabled (`marcode.enabledProviders` contains `'claude'` — no reason to prompt
  for a backend nobody runs). Action: write `CLAUDE.md` containing only the stub.
- Both present, or neither present: no nudge.

## Scope

In scope: workspace-wide scan (monorepo-aware) on activate, a dismissible sidebar card,
per-file and bulk migrate/add-stub actions, per-path dismiss persisted across reloads.

Out of scope: watching for new files live (re-scan happens on activate only, per the
approved trigger); resolving `@import` chains already present inside an existing
`CLAUDE.md` (a file that already imports something other than `AGENTS.md` is left alone —
migrating it would require understanding what it imports, which this feature does not
attempt); anything for providers other than Claude reading `CLAUDE.md` (nothing else does).

## Architecture

```
src/host/agents-md-nudge.ts     scan + dismiss-state + migrate/add-stub actions
  scanForHits(fileList, deps)   pure: given { dir -> {hasClaudeMd, hasAgentsMd} } entries,
                                 provider set, dismissed set -> Hit[]. Unit-testable without vscode.
  runNudge(context)             vscode glue: findFiles, workspaceState read/write, fs read/write,
                                 posts HostToWebview, handles WebviewToHost replies
```

Registered from `extension.ts` alongside the other `activate()` wiring, after workspace
folders and `enabledProviders` are known. Runs once; failures (permission errors during
scan) are logged and swallowed — a nudge that can't scan silently doesn't nudge, it doesn't
crash the panel.

### Scan

`vscode.workspace.findFiles('**/{CLAUDE.md,AGENTS.md}', '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}')`
— VS Code's `findFiles` already applies `files.exclude`/`search.exclude` by default, so the
explicit exclude glob only needs the directories that aren't reliably gitignored across
repos. Results are grouped by directory into `{ dir, hasClaudeMd, hasAgentsMd }`, then
`scanForHits` (pure, injectable file-list — same pattern as `message-router.ts` keeping
`vscode` out of testable logic) applies the Case 1 / Case 2 rule and filters against the
dismissed-paths set.

### Dismiss state

`context.workspaceState.get('marcode.agentsmdNudge.dismissed', [])` — array of
workspace-relative POSIX dir paths. A dir drops off the nudge list once dismissed *or* once
successfully migrated (resolved is also dismissed — nothing to re-flag). A new `CLAUDE.md`
appearing later in a dir not previously seen is not in the dismissed set, so it still
surfaces on the next activate (this is the reload-triggered rescan your colleague's new file
relies on — there is no live watcher, but every window reload re-scans).

### Protocol

```ts
// HostToWebview
{ type: 'agents-md-nudge', hits: Array<{
    dir: string            // workspace-relative, POSIX
    kind: 'migrate' | 'add-stub'
  }> }

// WebviewToHost
{ type: 'agents-md-nudge-action', action: 'migrate' | 'dismiss', dirs: string[] }
```

One message type for both bulk and single-row actions — the webview always sends the list of
dirs it wants acted on (`[oneDir]` for a row button, all listed dirs for "Migrate all" /
card-level dismiss).

### Migrate / add-stub execution

Sequential per dir, in `agents-md-nudge.ts`, via `vscode.workspace.fs`:

- `migrate`: read `CLAUDE.md`, write same bytes to new `AGENTS.md`, write `@AGENTS.md\n` to
  `CLAUDE.md`.
- `add-stub`: write `@AGENTS.md\n` to new `CLAUDE.md`. No read needed.

A failure on one dir (permission denied, read-only fs) is caught per-item, reported back to
the webview as a per-row error string on that hit, and does not stop the rest of a bulk
batch. Successful dirs are added to the dismissed set and dropped from the card; failed dirs
stay on the card so the action can be retried.

## UI

Dismissible `Card` at the top of the sidebar panel, above the roster (only rendered when
`hits.length > 0`). Header: count + short label ("3 files could use AGENTS.md"). Expandable
list, one row per dir: path, action-appropriate button ("Migrate" for Case 1, "Add stub" for
Case 2), row-level dismiss (X). Card-level "Migrate all" runs every listed action in one
batch; card-level dismiss (X) dismisses every dir currently listed. Built with shadcn
`Card`/`Button`, run through the `impeccable` detector after building per project convention.

## Testing

- Unit (`src/test/unit/`): `scanForHits` against synthetic dir maps — both cases, both-
  present, neither-present, dismissed filtering, provider-gate on Case 2.
- DOM (`src/test/dom/`): card renders from a genuine `agents-md-nudge` `HostToWebview`
  message via `sendFromHost`, migrate/dismiss buttons post the right `WebviewToHost`
  message, per-row error string renders on a failed action reply.
