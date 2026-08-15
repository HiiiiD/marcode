# hiiiid-code — Session Relocation Across Working Trees

**Date:** 2026-08-15
**Status:** Design approved in chat; pending implementation plan.

## Overview

A session's working directory is fixed for its lifetime. It is set once at
creation — in practice always the workspace root, since
[message-router.ts:97](../../../src/host/message-router.ts) falls back to
`defaultCwd` and nothing ever supplies anything else — and there is no way to
change it afterwards.

That collides with how the tool is actually used. A conversation plans a
feature, the agent creates a git worktree to implement it, and from that moment
the session and the work are in different directories. The agent's shell resets
to its launch cwd between commands, so it drifts back and writes to the root
repo. The panel cannot help, because it does not know the worktree exists.

This adds **relocation**: a session can move between working trees, in either
direction, carrying its conversation. It also adds the operation that closes the
loop — bringing a worktree's branch back into the main tree — because that is
the other half of the workflow and git makes it a multi-step operation with
preconditions.

The design rests on one reframing: **our transcript is the conversation; a
provider thread is a cache of it.**

## Evidence

Provider conversation history is keyed by working directory. The Claude CLI
stores it under `~/.claude/projects/<slugified-cwd>/`, and this machine's
directory listing shows one entry per worktree:

```
E--Efebia-hiiiid-code
E--Efebia-hiiiid-code--claude-worktrees-editor-context
E--Efebia-hiiiid-code--claude-worktrees-invocable-catalog
E--Efebia-hiiiid-code--claude-worktrees-subagents-and-mcp
```

Three consequences follow, and each shapes the design.

**A resume token is scoped to a directory.** `SessionState.resumeToken` is
passed as `resume` alongside `cwd` when the query is constructed
([claude-provider.ts:433](../../../src/providers/claude/claude-provider.ts)). The
token is a session id looked up under the project directory derived from `cwd`.
Start the same token in a different directory and the lookup finds nothing.

**Therefore relocation cannot be "a reload with a different cwd".** That was the
first approach considered and it is wrong. The run would come up as a fresh
conversation while our pane continued to display the full transcript — an agent
that has forgotten everything, behind a UI that shows otherwise. The failure is
invisible, which makes it the worst available failure.

**cwd is construction-time, not settable.** It is read once when the query is
built. A hypothetical `AgentRun.setCwd()` alongside `setModel` and
`setPermissionMode` would be a lie at the interface: those two genuinely
retarget a live query, and this one could only tear down and restart. Rejected
for that reason.

## What is not lost

Our own transcript is indifferent to all of this. `TranscriptStore` writes
per-session JSONL under `context.storageUri`, keyed by session id. Moving a
session, removing a worktree, or switching provider does not touch it. The
conversation as the user sees it is already durable and already ours.

What is missing is the reverse direction: a way to rehydrate a provider from
that record.

## Design

### The state model

A session no longer has *a* thread. It has one per (provider, directory) it has
run in:

```ts
// SessionState
resumeToken: string                        // before
resumeTokens: Record<string, string>       // after — key: `${providerId}:${cwd}`
```

`index.json` readers tolerate the old scalar and migrate it under the current
key on load, so sessions written by earlier builds survive the upgrade.

This one change covers every case:

| Move | Thread at destination? | Result |
|---|---|---|
| Root → new worktree | no | fresh thread, seeded by replay |
| Worktree → root (previously visited) | yes | native resume, free |
| Back out to a previously used worktree | yes | native resume, free |
| Claude → Codex, same directory | no | fresh thread, seeded by replay |

Cross-provider handoff is not a feature added here. It falls out of the key
including `providerId`, and is the same lookup missing.

### Replay

When no thread exists at the destination, the session is seeded from our
transcript. `src/host/replay.ts` is a pure projection, `(items, budget) =>
string`:

- User messages verbatim. They are the intent and are never compressed.
- Assistant final text kept. Deltas and thinking dropped — already coalesced.
- Tool calls reduced to name, key arguments, outcome. Full outputs dropped: they
  are the bulk of the bytes and the agent can re-read files itself.
- Framed explicitly as narration of what has already happened, not as
  instructions. Without that framing the agent re-executes the plan.

The seed never reaches the `AgentProvider` interface. `AgentSession` holds a
`pendingSeed` and prepends it to the first `send()` of a fresh thread — the same
lazy shape the Claude provider already uses for query construction. Providers
stay unaware replay exists.

**Replay is the boundary path, not the general one.** Native resume is used
whenever provider and directory are unchanged, because the providers do it
better and cheaper than we can. Replay runs only when a boundary is crossed.
The cost of that choice is a rarely-exercised code path, which the testing
section addresses directly.

Replay is lossy by construction. It re-sends the conversation as fresh input
tokens, so it has a budget and compacts to fit. Where a conclusion depended on a
tool output that was dropped, the agent re-runs the command. This is acceptable
and must be stated in the UI rather than hidden.

### Detection

`src/host/worktree-detect.ts` is pure — `(toolName, input, ok) => string |
undefined` — with no `vscode` import, so it unit-tests. It reads `tool-start` /
`tool-end` events, which every provider emits, so detection is provider-agnostic
rather than Claude-specific.

It recognises `git worktree add` in a shell command and returns the resolved
absolute path. It is deliberately narrow: it does not chase scripts, aliases or
`jj`. A missed detection costs nothing that is not already lost today; a wrong
detection would relocate a session into a directory nobody asked for. When it
cannot parse confidently it returns nothing.

It fires on `tool-end` with `ok: true`, never on `tool-start`. A failed command
created no tree, and an offer to move into a non-existent path can only produce
an error.

### The move-out card

A hit appends a **transcript item**, not an ephemeral pending-approval:

```
┌ Worktree created — .claude-worktrees/feat-x
│ Move this session there? Its history stays here.
│                            [ Move ]  [ Stay ]
└
```

Durable rather than pending, deliberately. It survives a reload, sits at the
right point in the scroll, and remains meaningful when answered later — unlike a
permission request, nothing is blocked waiting on it. Answered items render as
their outcome (`Moved to …` / `Stayed`), so the transcript reads as a record of
where the work happened.

On **Move**:

1. Refuse while the session is `busy`. A turn in flight finishes first; the
   button disables rather than interrupting.
2. `session.dispose()` — the existing path, which drains the pump and denies
   outstanding approvals.
3. `state.cwd = path`, then look up the thread for the `providerId:path` key in
   `resumeTokens`.
4. Reconstruct `AgentSession`. Token present → native resume. Absent →
   `pendingSeed = replay(items, budget)`, spent on the next send.
5. `catalogSvc.ensure()` on the new key. A worktree can carry a different
   `CLAUDE.md` and different skills, so invocables re-probe.
6. `changed()`, and a fresh snapshot if the session is visible.

Steps 2–4 are `archive()` → `open()` with one field changed. Relocation
introduces almost no new lifecycle.

### Bringing a branch back

Not detection-driven: nothing observable indicates the user *wants* a branch in
the main tree. It is an action in the pane header, offered when the session's
cwd is a worktree of the current repository.

Git refuses the same branch checked out in two worktrees, so this is
irreducibly multi-step: the worktree must let go before the main tree can take
the branch.

```
┌ Bring feat-x into the main tree?
│ • removes worktree .claude-worktrees/feat-x
│ • checks out feat-x here
│ ⚠ main tree has 3 uncommitted files
│                    [ Cancel ]   [ Bring back ]  ← disabled
└
```

Refuses while either tree is dirty, names which one, and offers no force path.
This is the only destructive operation in the feature, and the only one that
argues its case before acting.

**Ordering matters, because half-done is the bad state.** Git operations run
before the cwd change: worktree removed and branch checked out first, and only
then does the session relocate. A git failure leaves the session exactly where
it was, with a transcript item explaining why. There is no window in which a
session points at a directory that no longer exists.

Removing a tree also deletes its `resumeTokens` entry. Leaving it would let a
future worktree created at the same path silently resume a conversation
belonging to unrelated work.

### Stale worktrees

Trees accumulate. A panel-level surface lists every worktree the host has
associated with a session, with its dirty and ahead/behind state, so leftovers
can be swept — including trees whose sessions were deleted long ago. Removal
from that surface uses the same refusals as bring-back.

### Error handling

Git absent, not a repository, detached HEAD, branch checked out elsewhere,
worktree path already occupied: each becomes a transcript item. Errors are
state, never exceptions; nothing rejects across `postMessage`.

`src/host/git-worktree.ts` owns the shelling out. It imports `child_process` and
never `vscode`, so it unit-tests against a real temporary repository.

## Testing

**Pure units** (`yarn test:unit`):

- `worktree-detect` — a table of real command lines: `-b`, `--detach`, path
  before and after a commitish, quoted paths with spaces, Windows separators,
  `&&` chains. Negatives (`git worktree list`, `git worktree remove`) assert
  `undefined`, as does ambiguous input.
- `replay` — ordering preserved, user messages verbatim, tool outputs dropped,
  budget respected, narration framing present. Degenerate cases: empty
  transcript, and one oversized message that alone exceeds the budget.
- `resumeTokens` migration — an `index.json` carrying the old scalar loads under
  the current key; the new format round-trips.
- `git-worktree` — against a real temporary repository built in the scratchpad.
  Clean tree, dirty tree, branch checked out elsewhere, not a repository,
  detached HEAD. Each asserts the refusal *reason*, not merely that it refused.

**Router** — `relocate-session` and `bring-back` reach the intended manager
calls with the intended arguments.

**DOM** (`yarn test:dom`) — cards mounted under the real `StoreProvider`, state
delivered as genuine `HostToWebview` messages through `sendFromHost`, assertions
reading the messages posted back: Move posts `relocate-session`; the button is
disabled while status is `busy`; refusal reasons render; an answered card shows
its outcome. Booleans, strings and counts in every assertion — never a DOM node.

**Guarding the rare path.** Replay must not run only when someone moves a
worktree, or it will rot between uses. Two measures:

1. Every unit and DOM fixture session has its seed generated and asserted in CI,
   move or no move. The projection runs constantly even though the feature is
   rare.
2. An opt-in smoke test, following the pattern already established for codex:
   genuinely create a worktree, move a session, seed a fresh thread, then ask the
   agent what it was working on and assert it names the task. This is the only
   test that shows replay reconstitutes a conversation rather than producing
   well-formed text. Opt-in because it spends tokens and needs a signed-in CLI.

**UI gate.** The cards and the stale-worktree surface are new webview surfaces,
so `impeccable`'s detector runs over the changed component files and `critique`
runs before the branch merges.

## Open questions

**Does a fresh thread accept a prepended seed cleanly?** Expected yes — it is an
ordinary first message — but it has never been done here, and the smoke test in
measure 2 is what answers it.

**Does a round trip preserve the original thread?** Moving root → worktree →
root should resume the root thread untouched, since nothing deletes it. Believed
rather than verified; the same smoke test covers it.

## Out of scope

- Provisioning worktrees. The agent creates them mid-conversation; the host
  follows. No `git worktree add` is issued by the host.
- Dependency installation in a new tree. The agent runs its own install, as it
  would anywhere.
- Sharing one tree between concurrent sessions. Re-attach is per session and
  explicit.
- Consolidated cross-session diff review. Related and enabled by this, but its
  own piece of work.
