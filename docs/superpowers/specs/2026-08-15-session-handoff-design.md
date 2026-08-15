# hiiiid-code — Session Handoff

**Date:** 2026-08-15
**Status:** Design approved in chat; pending implementation plan.

## Overview

Cross-provider work is one-shot today. The same prompt can go to two sessions and
the outputs compared by eye, but nothing carries one session's result into
another's input. The pipeline case the positioning analysis names — Codex plans,
Claude implements — is a copy-paste, not a gesture.

This adds **handoff**: referencing one session's output as another session's
input, and creating a fresh session seeded from the one you are in.

Both rest on the same observation. `TranscriptStore` already holds every
session's history durably, and since the canonical tool layer landed, that
history is typed: a `role: 'tool'` item carries a `ToolCall`, so a plan is
`kind: 'plan'` with `text` rather than a name to string-match. The payloads a
handoff would want are already extracted. What is missing is a way to address
them.

## The two gestures

Both live in the composer, reached through one `@` menu. There are no per-item
action buttons anywhere.

### `@handoff` — seed a new session from this one

Typed in the source session's composer. Opens the existing create dialog,
pre-filled with that session's provider, model, effort and cwd, plus its own
composer for the new session's first message. Confirming creates the session and
sends that message.

The dialog's composer offers the same `@` menu, so the two gestures compose: a
new session seeded with another session's last message plus your own
instructions.

Free text is the whole point. The motivating case is a superpowers plan, which
`writing-plans` writes to `docs/superpowers/plans/*.md` — a file, not a
`kind: 'plan'` tool call. Handing that off means typing `Execute the plan in
docs/superpowers/plans/x.md`, and the fresh session reads the current file rather
than a snapshot of it. No extraction feature is needed for that, and a snapshot
would be worse than the pointer.

Why a fresh session rather than continuing: after a long planning conversation
the context window is full of the planning. An implementer that starts with only
the plan starts clean, and the context ring will show the difference.

Why the dialog rather than one click that inherits silently: the headline case is
cross-provider. A path that silently reuses the source's provider makes
"Codex planned, now give it to Claude" the awkward one, and that is the
differentiator.

### `@<session>` — pull a payload into this message

Typed in any composer, including the handoff dialog's. Inserts a reference to
another session; the host resolves it when the message is sent.

Payload kinds:

- `message` — that session's most recent settled assistant message. The default.
- `plan` — its most recent settled `kind: 'plan'` tool call. Distinct from a
  superpowers plan file; this is the inline ExitPlanMode-style plan.

## Wire protocol

```ts
// src/protocol/messages.ts
export type RefKind = 'message' | 'plan';
export interface SessionRef { sessionId: SessionId; kind: RefKind; title: string }

// user arm of TranscriptItem
| (ItemBase & {
    role: 'user'; text: string;
    context?: EditorContext;
    refs?: SessionRef[];
  })

// WebviewToHost
| { t: 'send'; id: SessionId; text: string; refs?: SessionRef[] }
| { t: 'create-session'; /* …existing fields… */
    seed?: { text: string; refs: SessionRef[] } }
```

`refs` rides on the user item the way `context?: EditorContext` already does, and
for the same reason: it is metadata about a message that the message itself
cannot carry.

**The host never parses `@` out of message text.** The webview authors the
reference and sends it as structured data. Two consequences, both wanted: a user
who types a literal `@agent-2` in prose triggers nothing, and every reference to
a session is an explicit `SessionId` on the wire — the standing invariant, which
a string parsed host-side would quietly break.

`title` travels with the ref so a transcript item renders its source without a
lookup that would fail once that session is deleted.

## Resolver

New module `src/host/session-refs.ts`. Imports no `vscode`, so it unit-tests
outside the extension host — the same constraint `message-router.ts` is under.

`SessionManager.resolveRef(ref)` supplies its items: from `session.snapshot()`
when the session is live (which also flushes pending writes), from
`store.tail(id)` when it is not.

Resolution rules:

- `message` — the most recent `role: 'assistant'` item, **excluding the live
  session's currently-open one**. This requires one addition to `AgentSession`: a
  getter for the open assistant item id.
- `plan` — the most recent `role: 'tool'` item with `tool.kind === 'plan'` and
  `state: 'ok'`. Searched backwards across turns rather than restricted to the
  last one: a plan is often several turns old by the time it is handed off.
- Neither found — `{ ok: false, reason }`.

A source session that is `running` resolves normally. An in-flight item is never
a candidate, so there is no partial payload to truncate and nothing to refuse.
Refusing a send because the source is busy would block on a hazard that cannot
occur.

The one genuine empty case is a source with no completed turn at all — a fresh
session, or one whose first turn is still in flight. That produces an error item
in the receiving session, per **errors are state, never exceptions**.

The remaining imprecision is accepted: if the source is mid-turn writing a better
answer, the pull gets the previous one. The source's status is visible, and the
`refs` metadata records what was pulled.

## Composing the prompt

The prose goes to the provider as typed, with tokens left readable
(`@agent-2 plan`), and each resolved payload appended after it as a fenced block.
The model sees both the reference and the content, and the composition is
positional rather than substitutional — no placeholder scheme to get wrong.

The transcript item's `text` is exactly what the provider received. The
transcript never disagrees with what the model saw.

## UI

Every surface here goes through the `impeccable` skill, per CLAUDE.md: the `@`
menu gets the skill's `shape` flow **before** it is built, and the mechanical
detector runs over every touched file under `src/webview/components/`.

- **Composer** — `@` trigger reusing the existing invocable-menu machinery
  ([invocable-menu.ts](../../../src/webview/lib/invocable-menu.ts),
  [invocable-menu.tsx](../../../src/webview/components/invocable-menu.tsx)),
  listing `@handoff` plus other sessions × payload kind. The inserted token
  renders as a chip.
- **Transcript** — a user item with `refs` renders each payload as a collapsed
  `▸ plan from agent-2` block above the prose, expandable. Without this every
  handoff is an undifferentiated wall of text in one bubble.
- **Create dialog** — seed composer, ref chips, and a `Create and send` confirm.

## Testing

- **Unit** — `session-refs.test.ts`: each payload kind, exclusion of the
  in-flight assistant item, both empty cases, and a source that is not live.
- **Unit** — router tests for `send` carrying `refs` and `create-session`
  carrying `seed`, including a ref naming a deleted session.
- **DOM** — the `@` menu and the seeded dialog, mounted under the real
  `StoreProvider`, state delivered as genuine `HostToWebview` messages, asserting
  on the messages posted back. Never a hand-built `ClientState`.

## Deliberately not in this design

**Per-item hand-off buttons**, on plan cards or anywhere else. The first version
of this design put the gesture on a `kind: 'plan'` card, which would have missed
the motivating case entirely — superpowers plans are files. Once the gesture
moved to the composer, the per-item action rows, file-path extraction and
selected-text handoff all became workarounds for having put it in the wrong
place.

**A `diff` payload.** Every other payload is already typed text; a diff would
need synthesizing from `FileEdit.edits` before/after pairs for providers that
report them that way. Consolidated diff review is its own gap and its own
surface.

**Whole-transcript payload.** It would blow the receiving session's context on
any real conversation.

**An agent-callable handoff tool.** A tool the agent could invoke to spawn a
session itself is real orchestration no first-party tool can do, but it means
exposing a tool *into* the agent loop — the one move the positioning analysis
says erodes the position — and it needs an MCP server or per-provider tool
injection. Revisit once the manual path has shown what the prompt should be.

## Interaction with session relocation

A fresh session created to implement a plan is exactly the case that wants its
own working tree. This design does not touch cwd: the dialog's folder field
behaves as it does today, and the new session inherits the source's directory.

Session relocation ([2026-08-15-session-relocation-design.md](2026-08-15-session-relocation-design.md))
is in flight. When it lands, the seeded-creation path gains a worktree option
with no change to anything specified here.
