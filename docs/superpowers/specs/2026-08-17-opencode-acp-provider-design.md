# OpenCode over ACP — design

**Date:** 2026-08-17
**Status:** approved, not implemented

## Why

OpenCode is the third backend the `AgentProvider` interface was written for. It speaks the
Agent Client Protocol — `opencode acp` is a documented, registry-listed ACP agent — so it
arrives as an opportunity to add a *protocol* rather than a vendor: Cursor, Gemini and
anything else in the ACP registry become a spawn recipe and a `map-tools.ts` afterwards.

Every claim in this document was measured against **opencode 1.18.18** with a throwaway
probe that spawned `opencode acp` and logged every frame. Where the measurement contradicts
the reference implementation we studied (`t3code`, whose OpenCode support does *not* use
ACP — it uses `@opencode-ai/sdk` over HTTP, and only Cursor and Grok go through their ACP
layer), the measurement wins and the difference is called out.

## Scope

In scope: a generic ACP client under `src/providers/acp/`, an OpenCode provider that
configures it, model and mode discovery, permission cards, a context ring, invocables,
same-directory resume.

Out of scope for v1: question cards, MCP status reporting, the usage strip, injecting our
own MCP server into a session, reasoning-effort control on installs that expose none.

## Architecture

```
src/providers/acp/            protocol, vendor-neutral
  acp-client.ts               spawn, JSON-RPC framing, initialize, dispatch
  acp-run.ts                  one session: lifecycle, prompt queue, parked permissions
  map-updates.ts              session/update -> AgentEvent (pure)
  config-options.ts           configOptions -> ModelInfo[] / modes / effort (pure)

src/providers/opencode/       vendor, thin
  opencode-provider.ts        AgentProvider: spawn recipe, fetchModels probe, modes
  map-tools.ts                opencode tool_call -> canonical ToolCall (pure)
```

The split is the point. `acp/` may not import anything OpenCode-specific; a second ACP
agent must cost a spawn recipe and a tool mapper, nothing more. Neither directory imports
`vscode`, per the existing invariant.

We take the official `@zed-industries/agent-client-protocol` package. t3code hand-rolled an
in-repo `effect-acp` with a codegen'd schema because their whole server is Effect-based; we
have no Effect runtime and no reason to own a schema generator.

## Transport and process model

One `opencode acp` child per session, `cwd` set to the session's directory, NDJSON JSON-RPC
over stdio.

**Windows:** Node 22 refuses to spawn `opencode.cmd` without `shell: true` — the probe hit
`EINVAL` immediately. The host will hit it too.

Client capabilities go out deliberately minimal:

```json
{ "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false }
```

OpenCode calls `fs/write_text_file` on us **anyway**, takes the resulting `-32601`, and
silently falls back to its own file IO — observed, with the edit still succeeding. Refusing
therefore costs nothing and keeps the host out of the file-writing business, which also
preserves the fleet-diff invariant: edits land on disk as opencode's own writes, and
attribution comes from the transcript's canonical `file-edit` calls rather than from us
mediating the write.

## Handshake

`initialize` with `protocolVersion: 1` returns, verbatim from 1.18.18:

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": true },
    "promptCapabilities": { "embeddedContext": true, "image": true },
    "sessionCapabilities": { "close": {}, "fork": {}, "list": {}, "resume": {} }
  },
  "authMethods": [
    { "id": "opencode-login", "name": "Login with opencode",
      "description": "Run `opencode auth login` in the terminal" }
  ],
  "agentInfo": { "name": "OpenCode", "version": "1.18.18" }
}
```

We do **not** call `authenticate`. OpenCode's only auth method resolves in a terminal, so an
unauthenticated install is an error state carrying that sentence — not something we can
settle on the wire. (t3code calls `authenticate` unconditionally because Cursor and Grok
have wire-resolvable methods.)

## Session lifecycle

- **New:** `session/new {cwd, mcpServers: []}` → `{sessionId, configOptions}`. The reply's
  `sessionId` is the `resumeToken`.
- **Prompt:** `session/prompt {sessionId, prompt: [...]}`, one in flight at a time. Resolves
  with `{stopReason, usage}`.
- **Cancel:** `session/cancel {sessionId}` is a *notification*. `interrupt()` sends it and
  waits for the outstanding `session/prompt` to resolve.
- **Resume:** `session/load {sessionId, cwd, mcpServers}`.

`mcpServers` is `[]` because that parameter is for the *client* injecting its own servers
(t3code injects a `t3-code` HTTP endpoint). The user's own servers load from their
`opencode.json` regardless. Passing `[]` disables nothing. This is the extension point if we
ever want hiiiid-code's own tools inside a session; `mcpCapabilities` says HTTP and SSE are
both available.

### Resume is hostile, and cross-directory resume is worse

Measured: `session/load` replays the entire history as `session/update` notifications
*before* answering. Same-directory load then completes.

From a **different** directory, opencode replayed the full history and **never answered the
request** — the probe hung past five minutes. So:

- **`threadScope: 'cwd'`.** A session id does resolve from anywhere, but the load does not
  complete, and the invariant is explicit that `'global'` must be measured before it is
  claimed. This measurement says no.
- Session relocation must never attempt a cross-directory `session/load`. It seeds a fresh
  session by replay, exactly as Claude's `'cwd'` case already does.
- Same-directory load suppresses every update until the load settles, then races the
  response against a 2-second idle gap — the mitigation t3code built, for behaviour we
  watched opencode perform.
- The probe never cleanly observed a `session/load` reply (the replay storm arrived first and
  the response did not land), so a resumed session must **not** depend on `configOptions`
  coming back from it. The model list comes from the provider's own probe. Confirm the reply
  shape during implementation.

## Event mapping

The six `session/update` variants 1.18.18 actually emits:

| `sessionUpdate` | `AgentEvent` |
|---|---|
| `agent_message_chunk` (`content.type === 'text'`) | `{kind: 'text', delta}` |
| `agent_thought_chunk` | `{kind: 'thinking', delta}` |
| `tool_call` | `{kind: 'tool-start', id: toolCallId, tool}` |
| `tool_call_update` → `completed` / `failed` | `{kind: 'tool-end', id, ok, output, tool}` |
| `tool_call_update` → `in_progress` | swallowed |
| `available_commands_update` | `{kind: 'invocables', entries}` (full replacement) |
| `usage_update` | feeds `contextBreakdown()` |
| `user_message_chunk` | swallowed — only appears during load replay |

`tool-end` re-sends `tool` because opencode needs the interface's replacement rule: a bash
`tool_call` arrives as `{title: 'bash', rawInput: {cwd}}` with **no command**, and only the
subsequent `tool_call_update` carries `rawInput.command` and the real title. A card rendering
start-time arguments forever would show a shell call with no command — the same failure the
`webSearch` note on `AgentEvent` describes.

t3code handles only four variants and drops `agent_thought_chunk` entirely, so their ACP
sessions have no reasoning stream. We map it.

`session/prompt` resolving → `{kind: 'turn-end'}`: `end_turn` → `done`, `cancelled` →
`interrupted`, anything else → `error`. Its `usage` payload
(`{inputTokens, outputTokens, totalTokens, thoughtTokens, cachedReadTokens}`) → one
`{kind: 'usage'}`.

### Tool mapping

OpenCode's payloads are already close to canonical, so `map-tools.ts` is thin:

- `kind: 'edit'` with `content: [{type: 'diff', path, oldText, newText}]` → canonical
  `file-edit` with `FileEdit`. This is also what fleet-diff attribution reads.
- `kind: 'execute'` with `rawInput.command` → the command block.
- `locations[].path` → the path block.
- Unknown kinds fall through to a generic call. They are **not** classified by lowercased
  substring matching on the tool name — the heuristic the canonical-tool-layer design
  explicitly rejected, and which is how t3code does it.

## Models

`session/new` returns the catalog directly — no vendor extension needed (t3code needs
`cursor/list_available_models` for Cursor):

```json
{ "id": "model", "category": "model", "type": "select",
  "currentValue": "opencode/big-pickle",
  "options": [ { "value": "opencode/big-pickle", "name": "OpenCode Zen/Big Pickle" } ] }
```

- `fetchModels(cwd)` spawns a probe child, initializes, opens a session, reads that option,
  then **closes the session** via the advertised `sessionCapabilities.close` before killing
  the child — otherwise every probe litters the user's opencode history.
- `ModelInfo.id` = `value`, `displayName` = `name`. No aliases, so no `resolvedModel`.
- No option, or an empty one, means an empty list means **the provider is unavailable**,
  carrying the probe's failure as its reason. No hardcoded fallback catalog. `seededModels`
  from `catalog.json` covers the hydrate gap exactly as it does for the existing providers.
- `setModel` → `session/set_model {sessionId, modelId}`. An unknown id returns
  `-32602 "model not found"`, which becomes session error state, never an exception.

**Effort.** This install exposed only `model` and `mode` config options — no reasoning
control — so `ModelInfo.effort` is omitted unless a config option with `category:
'thought_level'` or id `reasoning` is actually present, in which case its values become the
levels. We read what is there. t3code pattern-matches hopefully across three different
shapes; we do not.

## Permission modes

OpenCode splits the question in two: ACP `session/set_mode` decides *which tools exist*,
while the user's `opencode.json` decides *whether it asks at all*. `session/new` reports:

```json
{ "id": "mode", "category": "mode", "currentValue": "build",
  "options": [ { "value": "build" }, { "value": "plan" } ] }
```

`listPermissionModes()` returns four:

| mode | mechanism |
|---|---|
| `default` | `session/set_mode {modeId: 'build'}` |
| `plan` | `session/set_mode {modeId: 'plan'}` |
| `bypass` | wire-neutral: auto-select the `allow_always` option, never surface a card |
| `dontAsk` | wire-neutral: auto-reject anything opencode asks about |

`bypass` and `dontAsk` are honest because ACP hands *us* the decision: if opencode asks, we
answer; if it doesn't ask, that is the user's own config already permitting the call, which
is what both modes mean. Each mode's `description` says so — "whether opencode prompts at
all is your opencode.json" is exactly the provider-specific nuance `PermissionModeInfo.description`
exists for.

**`auto` and `acceptEdits` are not offered.** `auto` needs a classifier ACP does not provide.
`acceptEdits` is indistinguishable from `default` under a config that doesn't ask about
edits — the Codex precedent in the invariants. This is also where t3code's version is wrong
rather than merely different: `buildOpenCodePermissionRules` (opencodeRuntime.ts:334)
branches only on `full-access` vs everything else, so their `auto` and `auto-accept-edits`
modes silently collapse into `approval-required` for OpenCode sessions.

## Permissions

`session/request_permission` → `{kind: 'permission', id, tool, meta}`, `meta.title` from
`toolCall.title`. Observed request:

```json
{ "toolCall": { "toolCallId": "call_…", "kind": "edit", "status": "pending",
                "locations": [{"path": "…/notes.txt"}],
                "content": [{"type": "diff", "oldText": "hi", "newText": "hi"}] },
  "options": [ {"optionId": "once", "kind": "allow_once", "name": "Allow once"},
               {"optionId": "always", "kind": "allow_always", "name": "Always allow"} ] }
```

`respondToTool` replies `{outcome: {outcome: 'selected', optionId}}` with the `optionId`
**read off the request** — picking the `allow_once`-kind option to allow and the reject-kind
one to deny. t3code hardcodes the literal strings `"once"` / `"always"` / `"reject"`, which
is a Cursor-shaped assumption. A denial with no reject option offered falls back to
`{outcome: {outcome: 'cancelled'}}`.

Note that with a default `opencode.json` **nothing is ever asked** — the probe's first two
runs saw zero permission requests until `permission: {edit: "ask", bash: "ask"}` was set.
That is the user's configuration, not a bug, and it is why the mode descriptions must say
where the prompting decision lives.

## Context and usage

`usage_update` carries `{used, size, cost}` — e.g. `{"used": 8896, "size": 200000}`.

`contextBreakdown()` reports `conversationPercent` and `freePercent` from `used`/`size`, plus
`usedTokens`/`windowTokens` as the window caption — the single permitted token quote. OpenCode
reports one undifferentiated total, so `systemPercent` and `memoryPercent` are `0` and
`memoryFiles` is empty; the ring reads as one filled arc. We do not synthesise a system/memory
split from first-turn input tokens: that would invent percentages the provider never reported.

`fetchUsage` and `usageWindows` are **not implemented**. ACP carries no plan or rate-limit
data, so OpenCode is absent from the usage strip rather than showing an empty row — which is
what those optional methods are for.

## MCP

MCP servers configured in the user's `opencode.json` load and work in an ACP session.
OpenCode reports **no status** for them, so `mcp-servers` has no source and is never emitted.

The panel must not imply MCP is unsupported — it works; we are blind to it. The MCP section
renders for OpenCode panes with one muted line in place of server rows:

> MCP servers load from your opencode.json. OpenCode doesn't report their status, so they
> can't be listed here.

That line is webview copy and goes through the `impeccable` gate when built.

## Attachments

`promptCapabilities: {image: true, embeddedContext: true}`. Images go as
`{type: 'image', data, mimeType}` blocks; other files are named by path for the agent's own
tools. This is exactly what `Attachment.kind` already decides, so no new host-side model.

## Testing

- **Unit (mocha, no `vscode`):** `map-updates.ts` and `map-tools.ts` against recorded frames.
  The probe's captured JSON is committed as fixtures — the one artifact of the spike worth
  keeping. Cases: command-arrives-on-update, diff content, thought chunks, `usage_update`
  percentages, `available_commands_update`.
- **Unit:** `config-options.ts` — model extraction, empty list means unavailable, mode
  extraction, effort absent when no such option exists.
- **Unit:** permission answering — option id read off the request, `bypass` auto-allows,
  `dontAsk` auto-rejects, missing reject option falls back to `cancelled`.
- **Fake-driven:** an in-process scripted ACP stdio peer exercises `acp-run.ts` without
  spawning opencode — the `FakeProvider` philosophy one layer down.
- **Manual, not CI:** anything needing the real binary and a logged-in account.

## Registration

`hiiiidCode.enabledProviders` gains `"opencode"` in its default. Registration happens once at
`activate()`, as today, so the setting change prompts a window reload rather than pretending
to apply live. An install without the binary fails its probe and appears in `unavailable()`
with that reason — which is the mechanism working, not a special case.

## Open risks

1. **Cross-directory `session/load` hangs indefinitely.** Never attempted; relocation replays
   into a fresh session. If a future opencode fixes it, `threadScope` can be re-measured.
2. **Permission prompting depends on user config.** A user whose `opencode.json` allows
   everything will see no cards in any mode, and the mode descriptions are the only place
   that is explained.
3. **`opencode acp` has no `--auto` flag** (only `--port`, `--hostname`, `--cwd`, `--pure`,
   `--mdns`, `--cors`, log flags), and there is no permission env var. `OPENCODE_CONFIG`
   points at a whole config file, so using it would mean owning the user's provider and MCP
   configuration too. Rejected.
4. **ACP schema drift.** t3code pins to a codegen'd v0.11.3. We depend on the official
   package and treat unknown `session/update` variants as ignorable rather than fatal.
