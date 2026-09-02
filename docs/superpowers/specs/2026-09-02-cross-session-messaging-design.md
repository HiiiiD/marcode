# Cross-session, cross-provider messaging

## Scope

A session can send a message to another session it names, and get an answer
back later the same way — one-way or a back-and-forth, the caller's choice,
not a protocol primitive. Works across providers: a Claude session can message
a Codex session and vice versa, because the mechanism is the loopback
self-control MCP server every provider already connects through
(`self-control-mcp-server.ts`), not something backend-specific.

Out of scope: a synchronous "wait for B's reply" call (the MCP request would
have to stay open across B's whole turn, against a server built stateless-
per-request — see `self-control-mcp-server.ts`'s class doc); any cross-window
delivery (the server, and the whole roster, are one window's).

## A. Session naming

`SessionState` gains `name?: string`, user-set, distinct from the existing
`title` (still auto-derived, unchanged). Every session gets a default name at
creation — `${providerId}-${shortId}` — so it is addressable by tool before
anyone renames it; the roster shows a rename control (inline edit, matching
the panel's existing card-editing pattern) that sends a new
`WebviewToHost` `rename` message, handled by `SessionManager.rename(id, name)`.
Names are unique per window, case-insensitive; renaming to a name already in
use fails with an error surfaced the same way other roster actions report
failure. `name` persists in `index.json` alongside the rest of `SessionState`
— same durability as `title`, `permissionMode`, etc. — so it survives reload.

**Mentions get the same fix.** `session-mentions.ts` today labels `@` rows
with `s.title`, and every session starts titled `Untitled` — its own comment
flags the resulting collisions, worked around today with an id-suffix. Once
`name` exists, prefer it: label/`baseToken` use `s.name` when set, fall back
to `s.title` (with the existing suffix disambiguation) for a session nobody
has renamed yet. `SessionRef.title` keeps capturing whatever label was shown
at mention time — no wire-shape change there, same reasoning that already
governs it (a mention outlives the session it points to).

## B. Per-session identity on the self-control server

`send_message` needs to know which session is calling — today it can't tell.
`SelfControlMcpConfig` (`{ url, token }`) is minted once per *provider
instance* at `activate()` and shared by every session that provider runs; the
server has no way to map an inbound call back to a session.

Fix: mint one token per **session**, not per provider. `SelfControlMcpServer`
gains `mintToken(sessionId): SelfControlMcpConfig` and a `token → sessionId`
map, consulted on every request the same place the existing bearer check
already runs. A token is minted when a session starts (first `send()`, same
moment a Claude run is constructed lazily today) and revoked when the session
closes or is deleted.

This moves `selfControlMcp` off every provider's constructor and onto
`StartOptions` (`StartOptions.selfControlMcp?: SelfControlMcpConfig`), read
per-run instead of per-instance. Touches `claude-provider.ts`,
`codex-provider.ts` / `codex-run.ts`, `acp-run.ts` (and so
`opencode-provider.ts` for free, since it goes through `AcpRun`), plus
`extension.ts`'s wiring and each provider's existing self-control tests. This
is the largest single piece of the change, and it is a pure plumbing move —
no behavior changes for `spawn_session`, `recall`, or `recall_fetch`, which
never needed caller identity.

## C. Two new self-control tools

- **`marcode__list_sessions`** — no input. Returns
  `{ name, providerId, status, cwd }[]` for this window's live, non-archived
  sessions (same filter `session-mentions.ts` already applies). Lets an agent
  discover a target without the human pasting a name into the prompt.

- **`marcode__send_message({ to, text })`** — `to` is a session `name`.
  Handler:
  1. Resolve the caller's `sessionId` from its bearer token (the map from
     section B). No mapping → the token predates a session that has since
     closed; respond with an error.
  2. Resolve `to` by name. Unknown name, or `to === caller's own name` →
     error. (Names are unique by construction, so no ambiguity case.)
  3. `target.interrupt()` (no-op if idle) then
     `target.send(text, { from: { sessionId: caller, name: callerName } })`.
  4. Return immediately — delivery, not a reply. `{ delivered: true }`.

  Interrupt-then-send, not queue-then-wait-for-idle: this is a deliberate
  difference from the composer's own `send()` behavior (which parks a message
  behind whatever's running — see `agent-session.ts`'s `send` doc). A
  cross-session message is closer to an urgent steer than a typed follow-up,
  and the two paths already diverge for the "move" gesture, so a second
  divergence here is not a new pattern.

  Goes through the same tool-approval flow as any MCP tool call, including
  `spawn_session` — no extra restriction like `spawn_session`'s
  bypass-mode-child block, because sending text is not itself a privilege
  escalation; whatever B does with it is still gated by B's own permission
  mode.

## D. Transcript representation

**On B (the recipient):** the delivered text becomes an ordinary
`role: 'user'` `TranscriptItem` — it genuinely is B's next turn — with one
new optional field: `from?: { sessionId: SessionId; name: string }`. Absent
means human-typed (today's shape, no migration needed for existing JSONL).
Present renders a distinct pill ("Message from A") in `transcript-item.tsx`
instead of the default user avatar.

**On A (the sender):** `send_message` is a real MCP tool call the model made,
so it already produces a normal `role: 'tool'` item — permission card,
running/ok/error states, all for free, same machinery as every other tool
call. What changes is *rendering only*: `tool-render.ts` gets a case for
`marcode__send_message` (mirroring the fact that no such case exists yet for
`spawn_session` either, so this sets the pattern) that shows "Sent to B:
&lt;text&gt;" instead of raw JSON input/output.

`name` is captured into `from` at delivery time and never re-looked-up — same
rule as `SessionRef.title`: a transcript item describes what was true when it
was written, and a target renamed or deleted afterward must not reinterpret
history.

## Error handling

- Unknown/self `to` in `send_message` → tool error, model sees it, no
  transcript item written on either side beyond the failed tool call itself.
- Rename to a name already in use → error surfaced in the roster UI, no state
  change.
- Server fails to mint a token (shouldn't happen; mirrors the "self-control
  server failed to bind" posture already documented in `types.ts`) → session
  simply has no self-control tools that turn, same as today's failed-bind
  case.

## Testing

- Unit: `self-control-mcp-server.test.ts` — token minting/revocation,
  `list_sessions` filtering, `send_message` resolution (unknown/self/ok) and
  interrupt+send sequencing.
- Unit: `agent-session.test.ts` — `send()` threading `from` onto the appended
  item; `interrupt()` before `send()` composing correctly when a turn is live.
- Unit: `session-manager.test.ts` — `rename()`, uniqueness, default name at
  creation, `name` surviving a reload.
- Unit: `message-router.test.ts` — the `rename` op.
- Per-provider: existing self-control tests (`claude-provider.test.ts`,
  `codex-provider.test.ts`, `acp-run.test.ts`, `opencode-provider.test.ts`)
  updated for `selfControlMcp` moving from constructor to `StartOptions`.
- DOM: rename control in the roster; `from`-pill rendering in the transcript;
  `marcode__send_message` card rendering in `tool-render`/`tool-body`.
