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
anyone renames it. A rename control lives in two places, mirroring how
`Archive` already does — the roster row's actions menu, and the pane's own
"More pane actions" menu (`SessionHeader`), so a user working in a pane
never has to go find that session in the roster first. Both post the same
`WebviewToHost` `rename-session` message, handled by
`SessionManager.rename(id, name)`.
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
`SelfControlMcpConfig` (`{ url, token }`) is minted once per window at
`activate()` and shared by every session every provider runs; the server has
no way to map an inbound call back to a session.

**Not solved with a per-session token.** That was the first design here, and
it doesn't fit Codex: its self-control config reaches the spawned process
through a shared env var (`MARCODE_SELF_CONTROL_TOKEN`), read once by the
process-wide app-server and referenced by every thread that process runs
(`codex-run.ts`'s `bearer_token_env_var: 'MARCODE_SELF_CONTROL_TOKEN'`) — a
single `CodexProvider` instance's threads share one process and so can't each
carry a distinct token.

**Fix: identify the caller by URL, not by token.** The shared window-level
token stays exactly as it is today — it keeps gating whether a caller may
talk to the server at all, unchanged. What's new is `StartOptions` gaining a
plain `sessionId: SessionId` field (not part of `SelfControlMcpConfig`),
and every provider's *existing* per-run self-control URL construction
appending it as a query param: `${config.url}?sid=<sessionId>`. This is
already a per-run site in every provider that has one —
`claude-provider.ts`'s `buildOptions()` closure (closes over `opts:
StartOptions` already), `codex-run.ts`'s `startThread()` (reads
`this.opts`, built per-run by `CodexProvider.start()`), and `acp-run.ts`'s
`mcpServersFor()` (called per `newSession`/`loadSession`, gains a second
`sessionId` parameter) — so no provider constructor or `extension.ts`'s
provider wiring changes at all. `SelfControlMcpServer`'s request handler
parses `sid` off `req.url`; an absent or unrecognized `sid` (an id
`SessionManager` doesn't currently know) fails `send_message`/`list_sessions`
resolution with the same "unavailable" posture as no self-control config at
all — the bearer token remains the sole auth boundary, `sid` is routing
only, not a new secret.

This is a small, uniform addition to five already-per-run read sites plus
`StartOptions` and one new sender-resolution branch in
`self-control-mcp-server.ts` — not the provider-constructor refactor
originally sketched here. No behavior changes for `spawn_session`, `recall`,
or `recall_fetch`, which never needed caller identity.

## C. Two new self-control tools

- **`marcode__list_sessions`** — no input. Returns
  `{ name, providerId, status, cwd, self? }[]`, scoped to sessions with an
  open pane right now (`SessionManager.visibleIds()`) plus the caller's own
  session always, regardless of visibility, marked `self: true` — the only
  way an agent has to learn its own name, since nothing else identifies a
  session to the model running inside it. A window's full roster can span a
  long history of past sessions restored from disk; an agent addressing a
  target almost always means one open in front of the human right now, not
  that whole history, so the tool narrows to it rather than dropping the
  human into a large, mostly-irrelevant list. `send_message`'s own target
  resolution is unaffected by this scoping — it still searches every
  non-archived session, so a target the human names directly is reachable
  even if `list_sessions` never advertised it (discovery and reachability
  are separate guarantees).

- **`marcode__send_message({ to, text })`** — `to` is a session `name`.
  Handler:
  1. Resolve the caller's `sessionId` from the request's `sid` query param
     (section B). Missing or unrecognized → respond with an error.
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
call. What changes is *rendering only*.

An MCP tool call arrives as `ToolCall` kind `'mcp'` (`{ kind: 'mcp'; label;
server; tool }`, `tool-call.ts`), and `tool-render.ts` deliberately never
branches on a tool's *name* — only on `kind` — so its generic `'mcp'` case
today shows every MCP call, `send_message` included, the same way. This
change is the one narrow, explicit exception: `describeTool`'s and
`describeInput`'s `'mcp'` cases gain a check for
`tool.tool === 'marcode__send_message'` (the one name this file will ever
compare against) and render "Sent to `<to>`: `<text>`" from the call's input
instead of the generic server/tool chip. Called out here because it is a
deliberate, minimal crack in that invariant, not an oversight — a second
tool needing name-specific rendering should be reconsidered as a `ToolCall`
kind of its own instead of a second exception here.

`name` is captured into `from` at delivery time and never re-looked-up — same
rule as `SessionRef.title`: a transcript item describes what was true when it
was written, and a target renamed or deleted afterward must not reinterpret
history.

## Error handling

- Unknown/self `to` in `send_message` → tool error, model sees it, no
  transcript item written on either side beyond the failed tool call itself.
- Rename to a name already in use → error surfaced in the roster UI, no state
  change.
- Missing/unrecognized `sid` on a request (self-control server never started,
  or a stale/malformed value) → `send_message`/`list_sessions` respond with a
  tool error; other tools (`spawn_session`, `recall`, `recall_fetch`) are
  unaffected, since they never needed caller identity.

## Testing

- Unit: `self-control-mcp-server.test.ts` — `sid`-based sender resolution
  (missing/unknown/ok), `list_sessions` filtering, `send_message` resolution
  (unknown/self/ok) and interrupt+send sequencing.
- Unit: `agent-session.test.ts` — `send()` threading `from` onto the appended
  item; `interrupt()` before `send()` composing correctly when a turn is live.
- Unit: `session-manager.test.ts` — `rename()`, uniqueness, default name at
  creation, `name` surviving a reload.
- Unit: `message-router.test.ts` — the `rename` op.
- Per-provider: existing self-control tests (`claude-provider.test.ts`,
  `codex-provider.test.ts`, `acp-run.test.ts`, `opencode-provider.test.ts`)
  updated to assert the built URL carries `?sid=<sessionId>` from
  `StartOptions.sessionId`.
- DOM: rename control in the roster; `from`-pill rendering in the transcript;
  `marcode__send_message` card rendering in `tool-render`/`tool-body`.
