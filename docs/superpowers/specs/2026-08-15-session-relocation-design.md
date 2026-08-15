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

A session no longer has *a* thread. It has one per thread the provider
distinguishes:

```ts
// SessionState
resumeToken: string                        // before
resumeTokens: Record<string, string>       // after — key from threadKey()
```

Whether a migration is needed depends on ordering, and is settled in
Sequencing below: after the canonical tool layer's `version: 2` break there
are no older sessions left to migrate, and the field simply starts as a map.

### Thread scope is declared by the provider

The directory-keyed history in Evidence is a **Claude fact, not a universal
one**, and the host must not assume it. Codex multiplexes threads by `threadId`
inside one app-server process and takes `cwd` as a per-thread start parameter
([codex design](2026-08-14-codex-provider-design.md)); its `resumeToken` is that
`threadId`. If a Codex thread resumes regardless of directory, keying its tokens
by directory would force a replay to rebuild a conversation that would have
resumed for nothing.

So the provider declares its own scope, the same way it already declares its
permission modes and effort levels:

```ts
// AgentProvider
/**
 * Whether a resume token is valid only in the directory that produced it.
 *
 * 'cwd'    — history is stored per working directory (Claude: ~/.claude/projects/<slug>).
 *            Crossing directories needs a new thread, seeded by replay.
 * 'global' — a token resolves anywhere (Codex: threads keyed by threadId).
 *            Crossing directories is a native resume and costs nothing.
 */
readonly threadScope: 'cwd' | 'global';
```

`threadKey(provider, cwd)` returns `` `${providerId}:${cwd}` `` for `'cwd'` and
`providerId` for `'global'`. Everything downstream — lookup, migration, the
replay decision — reads that one function, so a provider whose scope is
mis-declared is a one-line fix rather than a redesign.

Declaring `'cwd'` when the truth is `'global'` costs tokens. Declaring
`'global'` when the truth is `'cwd'` costs correctness: the resume silently
finds nothing and the agent comes up blank behind a full transcript, which is
the invisible failure this whole design exists to avoid. **`'cwd'` is therefore
the safe default, and `'global'` must be measured before it is claimed.** Codex
is `'cwd'` until the smoke test in Testing shows otherwise.

This one change covers every case:

| Move | Thread at destination? | Result |
|---|---|---|
| Root → new worktree | no | fresh thread, seeded by replay |
| Worktree → root (previously visited) | yes | native resume, free |
| Back out to a previously used worktree | yes | native resume, free |
| Claude → Codex, same directory | no | fresh thread, seeded by replay |

Cross-provider handoff is not a feature added here. It falls out of the key
including `providerId`, and is the same lookup missing. The table above assumes
`threadScope: 'cwd'`; under `'global'` the first row is a native resume too.

### Interaction with the Codex provider

Two more, both coordination rather than conflict.

**The persisted field changes shape.** The codex design recovers from an
app-server crash with `thread/resume` against "the `threadId` already persisted
as `resumeToken`". The `AgentProvider` contract is untouched — `AgentEvent.session`
still carries exactly one token — but the host field it lands in becomes a map.
Cheaper if the codex branch lands first and this migrates it.

**Relocation must not thrash the shared process.** One `codex app-server` serves
the whole extension, ref-counted by live Codex sessions and torn down when the
last one goes. Relocation is dispose-then-reconstruct, so moving the only Codex
session drops the count to zero and immediately respawns a large Rust binary.
Either construct the replacement before disposing the original, or give teardown
a short grace period. Invisible until someone moves a lone Codex session, which
is why it is written down here rather than found later.

### Replay

When no thread exists at the destination, the session is seeded from our
transcript. `src/host/replay.ts` is a pure projection, `(items, budget) =>
string`:

- User messages verbatim. They are the intent and are never compressed.
- Assistant final text kept. Deltas and thinking dropped — already coalesced.
- Tool calls reduced from their canonical `ToolCall` to kind, `label` and the
  few fields that carry meaning — the command, the paths touched, the pattern
  searched. Full outputs dropped: they are the bulk of the bytes and the agent
  can re-read files itself.

  Reading canonical calls rather than provider vocabulary is what makes a seed
  portable. A Codex transcript summarized from raw wire types would hand Claude
  the words `commandExecution` and `fileChange`, which no user or model has read
  anywhere. This is the cross-provider case the thread key exists for, so the
  projection must be provider-neutral at the source.
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

`src/host/worktree-detect.ts` is pure — `(tool: ToolCall, ok: boolean) => string
| undefined` — with no `vscode` import, so it unit-tests.

It takes the canonical `ToolCall` from
[the canonical tool layer](2026-08-15-canonical-tool-layer-design.md), not a raw
name and input, and matches only `kind: 'command'`. That spec removes `name` and
`input` from the wire, so a detector reading them could not compile. The gain is
more than compliance: `ToolCall.command` is already normalized across providers —
including Codex's preference for `displayCommand`'s parsed actions over the
escaped invocation — so provider-agnostic detection becomes structural rather
than a coincidence of both adapters emitting shell strings.

It recognises `git worktree add` in that command and returns the resolved
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

## Sequencing

**The canonical tool layer lands first.** This design depends on it in three
places, and reversing the order means writing code against fields that are about
to be deleted.

1. **Detection is typed by it.** `worktree-detect` reads `ToolCall`, which does
   not exist until that spec ships. Written first, it would read `name` and
   `input` and then be rewritten.
2. **It removes the migration.** `StoredIndex` gains `version: 2` and
   `readIndex()` returns `EMPTY_INDEX` for anything else, so no session
   predating it survives to be migrated. `resumeTokens` starts as a map on a
   clean slate, and the tolerant-reader path is never written. Landing this
   first would mean shipping a migration that the very next change discards.
3. **It makes replay portable.** The projection summarizes canonical calls
   rather than provider vocabulary, which is what lets a Codex-produced
   transcript seed a Claude thread.

The relocation card is a new transcript-item role, additive to the item union
that spec rewrites. Authoring it afterwards means editing that union once.

## Testing

**Pure units** (`yarn test:unit`):

- `worktree-detect` — `ToolCall` values in, path or `undefined` out. A table of
  real command lines carried on `kind: 'command'`: `-b`, `--detach`, path before
  and after a commitish, quoted paths with spaces, Windows separators, `&&`
  chains. Negatives (`git worktree list`, `git worktree remove`) assert
  `undefined`, as does ambiguous input, as does every non-`command` kind.
- `replay` — ordering preserved, user messages verbatim, tool outputs dropped,
  budget respected, narration framing present. Degenerate cases: empty
  transcript, and one oversized message that alone exceeds the budget.
- `resumeTokens` — the map round-trips through `index.json`, and `threadKey`
  returns a directory-qualified key under `'cwd'` scope and a bare provider id
  under `'global'`. No legacy-scalar test: per Sequencing there is no legacy
  index to read.
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

**Does a fresh thread accept a prepended seed cleanly?** **Answered: yes.**
Measured 2026-08-15 against codex-cli 0.147.0 (`relocation-smoke.test.ts`, first
case): a session was given a subject in a repository root, moved into a real
linked worktree, and asked in the new tree what it had been working on. It
answered "We were working on the SUNFLOWER file-format parser for `.sun`
files." A seed is an ordinary first message and the agent treats it as
conversation, not as instructions.

**Does a round trip preserve the original thread?** Moving root → worktree →
root should resume the root thread untouched, since nothing deletes it. Believed
rather than verified; the same smoke test covers it.

**Is Codex `threadScope: 'global'`?** **Answered: yes.** Measured 2026-08-15
against codex-cli 0.147.0 (`relocation-smoke.test.ts`, second case): a thread
started in one directory and resumed from another kept its conversation, with a
same-directory control in the same test so a broken resume can never be read as
a scope result. `CodexProvider.threadScope` is `'global'`, and the test asserts
that declaration against what it observes — if a future CLI files history per
directory, the test fails rather than the value quietly going stale.

Consequence: relocating a Codex session is a native resume and spends nothing on
replay. The replay path remains load-bearing for Claude, whose history really is
filed under `~/.claude/projects/<slug>`.

The first attempt could not measure this at all, and the reason is worth
keeping: *no* `thread/resume` produced a turn, not even in the directory the
thread was born in. `thread/start` answers `{ thread: { id, … } }` rather than
`{ threadId }`, and `CodexRun.startThread` survived that only because the
separate `thread/started` notification resolved the id; `thread/resume` sends no
such notification, so `ensureStarted()` never resolved and the turn was dropped
silently. Fixed on master in `3bcfbd9`, which also closed a worse bug the same
mismatch caused — `thread/started` names its thread under `thread.id`, so the
provider's fan-out handed every live run every other session's start and two
Codex sessions in one window ended up sharing a thread. The scope became
measurable only after that landed.

So it stays `'cwd'` — the safe direction, costing tokens rather than
correctness. The test is a guard as well as a measurement: it asserts
`threadScope === 'global'` matches what the binary actually did, so whoever
fixes the resume path gets the answer for free.

## Out of scope

- Provisioning worktrees. The agent creates them mid-conversation; the host
  follows. No `git worktree add` is issued by the host.
- Dependency installation in a new tree. The agent runs its own install, as it
  would anywhere.
- Sharing one tree between concurrent sessions. Re-attach is per session and
  explicit.
- Consolidated cross-session diff review. Related and enabled by this, but its
  own piece of work.
