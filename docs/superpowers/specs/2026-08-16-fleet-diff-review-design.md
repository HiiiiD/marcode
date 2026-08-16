# Fleet diff review

**Status:** design
**Date:** 2026-08-16

## The problem

N sessions produce N sets of file changes. The panel has no surface that answers "what
did they actually do". Per-edit diffs already render inside transcript cards, but reading
five transcripts to reconstruct five change sets is the manual work this feature deletes.

Attention routing says *who* finished. This says *what they wrote*. Without it the fleet
is only half observable.

## What this is

One surface listing every file each session changed, live, grouped by session, opening
into VS Code's own diff editor.

What it is **not**:

- Not a diff renderer. VS Code has one; the panel lists and links.
- Not a staging UI. Nothing here mutates a working tree. Staging and discarding are
  VS Code's SCM view, and a destructive action inside a sidebar list is the wrong place
  to put a mistake.
- Not a review-comment system.

## The core idea: attribution and content come from different places

Git can say what changed in a tree. It cannot say *which session* changed it — several
sessions commonly share the main repo root, and git sees one dirty tree.

The transcript can. Every provider's adapter already emits a canonical
`{ kind: 'file-edit'; label; files: FileEdit[] }` (`src/providers/canonical/tool-call.ts`),
each `FileEdit` carrying a `path` and an `op`. The panel therefore knows which paths a
session wrote, provider-agnostically, from data it already stores.

So:

- **Content** — what the change is — comes from git, per tree.
- **Attribution** — whose change it is — comes from the transcript, per session.

This is a capability that follows from being an orchestrator that owns every transcript.
A single-agent tool has no reason to build it and a git-only view cannot.

### What attribution honestly cannot do

Three limits, each surfaced in the UI rather than hidden:

1. **Shell-made changes have no claim.** `sed -i`, a build script, a `git checkout`, a
   formatter run by a hook — no `file-edit` tool call, so no claim. These land in the
   tree's **unattributed** group. Inventing an owner would be worse than saying nobody
   claimed it.
2. **Two sessions, one file, one tree.** The file lists under both, flagged, sharing one
   combined diff. Git cannot split a file's changes by author and neither can we. Saying
   so is the honest rendering.
3. **A claim is not proof the change survived.** A session may write a file that another
   session later reverts. The claim says "this session wrote here"; the diff says what is
   there now. Where the two disagree the diff wins, and a claimed path with no diff is
   simply not listed.

## Data model

The user reads this as tree → session → files: a tree is the unit git can answer for, a
session is the unit the user thinks in. A tree with exactly one session collapses to that
session in the UI, which is the common case after worktree relocation.

The **payload is flat** — a tree carries its files, and each file carries the sessions
claiming it. The session grouping is derived in the webview from `claimedBy`. Sending it
pre-grouped would duplicate every file claimed by two sessions and make the shared-file
case unrepresentable without a second, contradictory copy of its diff.

Declared in `src/protocol/messages.ts` beside `StaleTree`, following the rule that a
payload crossing the wire is declared in the protocol and re-exported type-only by the
module that produces it (as `BringBackPlan` is, `git-worktree.ts:36`).

```ts
export type ChangeOp = 'create' | 'modify' | 'delete' | 'rename';

export interface FileChange {
  /** Repo-relative, POSIX separators — the spelling git reports. */
  path: string;
  /** Set only for a rename; the path the file moved from. */
  from?: string;
  op: ChangeOp;
  /** Undefined for a binary file, where git reports no line counts. */
  insertions?: number;
  deletions?: number;
  /** Sessions whose transcripts claim a write to this path. May be empty. */
  claimedBy: SessionId[];
}

export interface TreeDiff {
  /** Resolved absolute path of the working tree root. */
  root: string;
  branch?: string;
  /** Sessions occupying this tree, roster order. */
  sessions: SessionId[];
  /** How the base was resolved — the UI states which, never guesses. */
  base:
    | { kind: 'merge-base'; ref: string; sha: string }
    | { kind: 'head' };
  files: FileChange[];
  /** Files beyond the render cap, omitted from `files`. Never truncate silently. */
  omitted: number;
  /** Why this tree has no diff. Set means `files` is empty and the row shows this. */
  reason?: string;
}
```

Wire messages, panel-wide and unaddressed — matching `request-stale-trees` / `stale-trees`,
which are unaddressed for the same reason (the answer spans every session at once):

```ts
  /**
   * "What has the fleet changed?" Read-only and deliberately not
   * session-addressed: a working tree is the unit git can answer for, and
   * two sessions sharing one tree share one answer.
   */
  | { t: 'request-fleet-diff' }

  /**
   * Ask the host to open a file's change in VS Code's own diff editor.
   * Carries the tree because a repo-relative path is meaningless without it.
   */
  | { t: 'open-file-diff'; root: string; path: string }
```

```ts
  /**
   * The answer to `request-fleet-diff`. A complete replacement, never a
   * delta: it describes disk at an instant, and a merged delta would let a
   * stale row outlive the change it described.
   */
  | { t: 'fleet-diff'; trees: TreeDiff[] }
```

## Host: `src/host/fleet-diff.ts`

A sibling of `git-worktree.ts`, bound by the same two rules stated in that file's header:

- **Every failure is a returned reason, never a throw.** A tree that cannot be read
  becomes a row carrying why, exactly as a refused `bringBackPlan` stays a `StaleTree` row.
- **Never `shell: true`.** `execFile` with an argv array and an explicit `cwd`. Paths
  contain spaces; this is the boundary where a directory name would otherwise become
  shell syntax.

No `vscode` import, so it unit-tests outside the extension host.

### Which trees

`SessionManager.knownDirectories()` already enumerates every directory the panel touches
and dedupes case-insensitively on win32. Fleet diff needs a narrower set — directories
that are a session's `cwd`, not directories a resume token merely remembers — so it uses
the same dedupe rule over `meta` (the roster, as `staleTrees` does) and resolves each to
a tree root via `treeStatus`. Two sessions in one tree produce one `TreeDiff` naming both.

Non-repos are dropped entirely rather than listed with a reason: a session running in a
plain directory has nothing to review, and a permanent row saying so is noise.

### Base resolution

In order, first that succeeds:

1. `symbolic-ref refs/remotes/origin/HEAD` → the remote's default branch.
2. `rev-parse --verify --quiet` against `origin/main`, `origin/master`, `main`, `master`.
3. Failure → `base: { kind: 'head' }`.

Then `merge-base <base> HEAD`. If that fails (unrelated histories, no commits yet), fall
back to `{ kind: 'head' }` as well.

`{ kind: 'head' }` means the diff shows uncommitted work only. That is a materially
different reading of a session and the UI says which base it used, per the same principle
that keeps the context dialog's window line: a number nobody can locate is not an answer.

### Content

Two commands per tree.

```
git -c core.quotepath=false diff --numstat -M <base>
git -c core.quotepath=false ls-files --others --exclude-standard
```

The first is the whole change set. `git diff <base>` — with no `..HEAD` — compares the
working tree against the base, so committed and uncommitted changes arrive together, in
one command, already merged per path. Committed-only or uncommitted-only would each need
their own command and then a merge pass; this needs neither.

`-M` detects renames, reported as `old => new`. `core.quotepath=false` stops git escaping
non-ASCII paths into `"\303\251"` octal, which would never match a transcript claim.
Binary files report `-` for both counts and become `insertions: undefined`.

The second lists untracked files — an agent creating a new file is the single most common
change there is, and `diff` does not see it. Each becomes `op: 'create'` with undefined
counts (counting lines would mean reading every new file on every refresh).

Render cap: 500 files per tree, remainder reported in `omitted`. A silent truncation reads
as "that's everything" when it isn't.

## Attribution

`SessionManager` holds `Map<SessionId, Set<string>>` of repo-relative POSIX paths.

**Nothing is persisted.** No `SessionState` field, no `StoredIndex` bump — it stays v2.
Claims describe a tree at an instant, and a restored claim would describe an install
nobody checked this launch, the same reason a failed model probe is never persisted.

**Live.** `AgentSession` reports `file-edit` paths on `tool-end`, at the seam beside
`offerRelocation` (`agent-session.ts:574`). One deliberate difference: relocation skips
subagent tool-ends (`:565-571`) because a subagent's worktree has no claim on where the
parent conversation lives. Attribution does **not** skip them — a subagent's edit changes
this session's tree and is this session's change on disk. Subagent tool-ends must report
before their early return.

**Backfill.** On the first `request-fleet-diff` after a reload, each session's claims are
rebuilt once by paging its JSONL through `TranscriptStore` and collecting `file-edit`
items. Cached in memory thereafter. This keeps restored sessions from dumping their whole
history into `unattributed` without adding a persisted field that could go stale.

### Normalization

This is where the bugs will be, so it is one exported function with its own tests.

`FileEdit.path` is "absolute where the provider gave one, POSIX separators" — otherwise
relative to the session's cwd. Turning that into something matchable against git output:

1. `resolve(session.cwd, path)` → absolute, platform separators.
2. Make relative to the tree root.
3. Back to POSIX separators.
4. Compare under `samePath`'s rule — case-insensitive on win32 only. That rule already
   exists in `git-worktree.ts:81` and is not respelled here; a second spelling is a second
   thing to get wrong on one platform.

A claimed path that resolves outside its tree root is dropped, not clamped. An agent
writing outside its own tree is a real event, but it is not this tree's diff.

## Freshness

Diffs describe disk at an instant, so like `staleTrees` they are **cleared on `hydrate`**
and never restored.

Refetched on:

- the surface opening, and its manual refresh control;
- `turn-end` for any session in a listed tree;
- **`file-edit` tool-end, debounced 750ms** — this is what makes it live. Watching four
  agents' change sets grow during a turn is the point; a view that only settles at idle
  answers a question you could already answer by waiting.

Only trees whose sessions actually emitted an edit re-run their git commands. A debounce
per tree, not one global, so a busy session cannot starve a quiet one's refresh.

## Webview

### Mount and gating

The surface replaces `PaneGroup` in the flexing middle div (`app.tsx:83`), leaving the
session picker and usage strip in place. Entry is a toolbar button in `SessionPicker`,
beside the working-trees button (`session-picker.tsx:153`).

`useIsNarrow` becomes `usePanelWidth(ref)` returning pixels, with `narrow` and `canReview`
both derived from that one number. This preserves the property its doc comment argues for:
a single `ResizeObserver` on a single element, so two thresholds cannot disagree about the
same panel width. `NARROW_PX = 500` is unchanged; `REVIEW_PX = 700`.

Below `REVIEW_PX` the entry button is not rendered. A file list with churn counts and
session chips in a 300px column is the failure this gate exists to prevent.

**The open surface is derived, not imperative:** `reviewOpen && canReview`. Shrinking the
panel while it is open falls back to panes automatically — with an imperative close the
user would otherwise be stranded in an unusable surface at 300px with no visible way out —
and widening again restores it, because the intent flag was never cleared.

### State

One slice on `ClientState`: `fleetDiff: TreeDiff[] | undefined`, where `undefined` means
"never asked" and `[]` means "asked, nothing changed" — two different renderings (a prompt
versus an empty state). Cleared in `hydrate` alongside `staleTrees`, whole-replaced in
`reduce` on `fleet-diff`. `reviewOpen` is client-local, on `ClientAction`.

### Rendering

Per tree: root basename, branch, base caption, occupant session chips. Per session within
it: session title, file count, total churn. Per file: op glyph, path (basename emphasized,
directory muted), `+n −m`, and a marker when `claimedBy.length > 1`. Unattributed files
group last, under a header stating why they are unclaimed.

Composed with vendored shadcn primitives and `cn`, per the project's UI rules. The surface
goes through the `impeccable` skill — `shape` before building, the mechanical detector over
every changed file after.

## Opening a diff

`vscode.diff` needs two URIs. The right side is the file on disk. The left side is the
file's content at the base ref, which does not exist on disk.

A `TextDocumentContentProvider` registered for a `hiiiid-diff:` scheme supplies it, running
`git show <sha>:<path>` in the tree. Untracked and created files return empty content, so
the diff reads as all-added.

Deliberately not delegating to the built-in git extension's `git:` scheme or its
`git.openChange` command: both are another extension's internal surface, unversioned for
our use, and a broken diff link on a machine where it changed would be untraceable.

The call reaches `vscode` through the existing `EditorContextHost` shim
(`panel-view-provider.ts:15`, threaded into the router at `:57`), gaining an `openDiff`
member beside `reveal`. `message-router.ts` still imports no `vscode`, which is what keeps
it unit-testable.

## Errors

Consistent with the project rule that errors are state, never exceptions:

- A tree git cannot read → a row with `reason`. Never a thrown error, never a toast.
- A file whose diff cannot open → logged, as `revealFile` already does for a dead chip. A
  transcript can outlive the file it points at, and so can a diff row.
- A refresh failing mid-flight leaves the previous answer on screen, marked stale, rather
  than blanking a list the user is reading.

## Testing

Following the house style, which for git is real repositories and no mocks — see the header
of `src/test/unit/stale-trees.test.ts`, whose `panelInWorktree` fixture (`:47-72`) is
reused here.

**Unit, real git:** base resolution down each fallback rung; committed-plus-uncommitted
arriving merged from one `diff <base>`; rename via `-M`; binary reporting undefined counts;
untracked via `ls-files`; a non-ASCII path surviving `core.quotepath=false`; a non-repo cwd
dropped; the 500-file cap reporting `omitted`.

**Unit, pure:** path normalization — absolute and relative provider paths, POSIX and
platform separators, win32 case-insensitivity, a path outside the tree dropped; claim
collection including subagent tool-ends; backfill from a JSONL fixture.

**Unit:** the two new router arms.

**DOM:** the surface mounted under the real `StoreProvider`, state arriving as a genuine
`fleet-diff` message via `sendFromHost`, assertions reading the `open-file-diff` message
posted back. Gating asserted at widths either side of `REVIEW_PX`, and the derived-close
behaviour by shrinking while open. Assertions compare booleans, strings and counts —
never a DOM node, per the rule in `CLAUDE.md`.

**Integration:** the content provider registers and returns blob content for a real ref.

## Out of scope

- **Staging, discarding, committing.** VS Code's SCM view does this well, and the diff row
  is one click from it.
- **An editor-tab webview.** Opening this in a full editor column would dissolve the width
  problem rather than gate around it, and would lift the panel's 300–500px ceiling
  generally. It needs a second webview and a second transport, which is a change to how the
  extension is shaped, not a feature of this one. Right follow-on, wrong first version.
- **Cross-tree comparison** — diffing session A's answer against session B's for the same
  task. Interesting, and squarely an orchestrator capability, but it needs this surface to
  exist first.
