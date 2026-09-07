# Marcode — @ mention becomes plain autocomplete; context pull moves to MCP

**Date:** 2026-09-07
**Status:** Design approved, pending implementation plan

## Overview

Today the composer's `@` menu does two unrelated things at once: it lets the
user autocomplete a session's name into the message they're typing, and — for
a session row specifically — it silently attaches a `SessionRef` that the host
resolves into a recap block (files touched, commands run, last plan, last
reply) and appends to the outgoing prompt at send time. The second behavior is
a host-side heuristic the *user* triggers by typing a name, not something the
receiving agent asked for or can control the shape of.

This change splits the two: `@` stays a fast way to name a session (and
files), but stops silently attaching any content. Pulling another session's
context becomes something the **agent** does explicitly, on its own judgment,
mid-turn, via a new MCP tool — `marcode__get_session_context` — alongside the
other `marcode__*` self-control tools it already has.

## Goals

- Keep `@` in the composer as an autocomplete for session names (and files) —
  the original ask.
- Remove the host's automatic recap-and-append behavior for newly typed `@`
  session mentions.
- Give the agent a tool to pull a live (or recently active) session's raw
  transcript slice itself, whenever it decides it's relevant — not only what
  the user thought to attach before sending.
- Don't break replay of transcripts written before this change.

## Non-goals

- Changing `@file` mention behavior (unaffected).
- Changing the `handoff` action row (unaffected — still its own dialog).
- Retiring `RefKind`, `findPayload`, `buildRecap`, or `resolveRefs()` — legacy
  transcripts on disk already carry `SessionRef{kind:'message'|'plan'}` and
  must keep resolving on replay, the same reasoning already applied when
  `plan` rows were dropped from the menu while `plan` resolution stayed.
- A UI affordance for the new tool's output — it is agent-consumed, same as
  `marcode__recall_fetch`.

## Design

### 1. `@` menu: session rows stay, payload loses its pull

`session-mentions.ts`'s `sessionMentions()` keeps emitting one row per
referable session (unchanged: filtered to on-screen, non-self, non-archived,
same `handoff` action row). What changes is the payload a picked row
contributes: instead of

```ts
payload: { kind: 'session-ref', ref: { sessionId: s.id, kind: 'message', title: s.name } }
```

a picked session row inserts its slugged name as literal text and contributes
nothing further — no `SessionRef`, nothing for `sessionRefsOf()` to find. The
insertion mechanics (`tokenFor`, `spliceMention`, `pruneMentions`) are
unchanged; only the payload shrinks to "this token names a session," which
`sessionRefsOf()` no longer recognizes as a source of refs.

Net effect on `composer.tsx`: a `send` built from text containing `@session`
mentions carries no `refs` from those mentions. (`@file` mentions are
untouched and keep carrying `fileRefs` exactly as before.)

`session-refs.ts` (`findPayload`, `buildRecap`, `composePrompt`) and
`SessionManager.resolveRefs()` are **not touched**. They keep working exactly
as today, because:

- Transcripts written before this change still contain `SessionRef{kind:
  'message'}` entries from mentions typed under the old behavior, and
  replaying/resolving those must keep working.
- `RefKind` stays `'message' | 'plan'` on the wire for the same reason.

This mirrors the existing precedent in the codebase: `plan` rows were already
removed from the `@` menu while `findPayload`'s `plan` branch stayed alive for
legacy resolution. `message` now gets the identical treatment.

### 2. New tool: `marcode__get_session_context`

Registered in `self-control-mcp-server.ts` beside the existing
`marcode__list_sessions` / `marcode__send_message` / `marcode__spawn_session` /
`marcode__recall` / `marcode__recall_fetch` tools, same file, same
`buildMcpServer()` registration point.

**Input:**
```ts
{
  name: string,     // a session name from marcode__list_sessions
  limit?: number,   // max transcript items to return; default 30
}
```

**Resolution**, mirroring `SessionManager.resolveRefs()`'s existing live/dead
split:
- Live session (`this.sessionManager.get(target.id)` resolves) → its current
  `snapshot().items`, tail-limited to `limit`.
- Not live but known (`summaries()` still lists it, not archived) →
  `store.tail(sessionId, limit)`.
- Unknown/archived/self → error, same shape as `marcode__send_message`'s
  existing checks (`Unknown session: ${name}`, cannot target self).

**Output:** the raw `TranscriptItem[]` slice as JSON — no summarizing, no
recap. This is deliberately the same shape `marcode__recall_fetch` already
returns for archived sessions (`MemoryDetail.items`), so a caller that has
used one already knows how to read the other. The agent decides what matters
in it; the host does not pre-digest.

**Description text** follows the same "Marcode-specific, distinct from your
harness's own tools" framing every other `marcode__*` tool description
already uses, so a Claude/Codex/OpenCode agent doesn't confuse it with a
built-in memory/context tool.

`SessionManagerLike` (the structural interface this file already declares,
importing nothing from `session-manager.ts` or `vscode`) gains whatever
narrow surface the resolution needs — likely nothing new, since `get()` and
`summaries()` already exist there, plus a way to read a dead session's tail.
If `store.tail()` isn't already reachable through `SessionManagerLike`, it
gets added as a new structural method (`tail(id, limit): Promise<{items:
TranscriptItem[]}>` or equivalent) rather than importing `TranscriptStore`
directly, keeping this module's no-`vscode`-in-graph invariant intact.

### 3. Error handling

Same posture as every other tool in this file: never throws, always returns
`{ isError: true, content: [...] }` on a bad name, unknown session, or
self-reference, matching `marcode__send_message`'s existing checks.

### 4. Testing

- `session-mentions.test.ts` (or wherever `sessionMentions()` is covered):
  rows still present for each referable session; payload assertion changes
  from `{kind:'session-ref', ref}` to whatever the plain-text-only payload
  becomes (or the row contributes no payload beyond its token — the
  implementation plan pins the exact shape).
- Composer test: sending a message with a `@session` mention in its text
  asserts the outgoing `send` carries no `refs` — only `fileRefs` if a file
  was also mentioned.
- `self-control-mcp-server.test.ts`: new case(s) for
  `marcode__get_session_context` — live session, dead-but-known session,
  unknown name, self-reference, `limit` respected.
- Existing `resolveRefs()`/`findPayload`/`buildRecap` tests are untouched —
  they keep proving legacy resolution still works.

## Open questions

None outstanding — `limit` default (30) is a starting guess the implementation
plan can revisit if it reads awkwardly against real transcript sizes.
