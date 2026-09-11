# Marcode — OpenCode subagent tool visibility, via a supplemental SDK tap

**Date:** 2026-09-10
**Status:** Design approved, pending implementation plan

## Overview

OpenCode's `task` tool spawns a genuine child session, but nothing a subagent
does is visible in Marcode today. Its own tool calls, text, and permission
asks never reach the ACP bridge Marcode talks to: `opencode acp`'s own
`ACPSession.tryGet(sessionId)` registry (`packages/opencode/src/acp/session.ts`)
only knows sessions opened via `session/new`/`session/load`, and a `task`-tool
child is created through opencode's internal `Session.Service` instead — a
different store entirely. Every `session/update` for that child, and every
`permission.asked` it raises, is silently dropped
(`packages/opencode/src/acp/event.ts`, `permission.ts`) before it reaches the
wire. The parent's own `task` tool call still completes normally, carrying
only a final result string.

A real fix (`anomalyco/opencode#40438`, merged 2026-08-05) exists but lives on
`v2` — a branch `packages/cli/src/acp/*`, 1208 commits behind the `dev`
branch that today's releases (`v1.18.x`) actually ship from. Not available to
build against.

This design gets full subagent visibility today, without ACP, without
waiting on `v2`: `opencode acp` is not pure stdio — its own handler
(`packages/opencode/src/cli/cmd/acp.ts`) starts a real local HTTP+SSE server
(`Server.listen(opts)`) and drives the ACP bridge through the published
`@opencode-ai/sdk` client pointed at it. We can pin that server's port when
we spawn the process, and open our own second `@opencode-ai/sdk` connection
to the exact same server — same process, same session store, not a second
opencode instance. Its global event stream (`sdk.global.event()`) is
unfiltered: every session's raw events, task-tool children included, with
`session.created` carrying `parentID` in the clear.

## Goals

- Subagent tool calls and text render live, nested under the parent's `task`
  tool-call card — same UX as Claude's sidechain nesting and Codex's rejoined
  thread today.
- A subagent's own permission asks get answered instead of hanging forever
  (the same `ACPSession.tryGet` gate drops `permission.asked` for a child
  session too — confirmed independently as `anomalyco/opencode#12133`).
  OpenCode has no auto-approve session default, so this is not an edge case:
  a subagent doing anything beyond its most restricted tools will hit one.
- Zero change to every other provider, and to everything else the opencode
  provider already gets from the shared `acp/` layer — models, modes,
  main-thread permissions, content mapping stay exactly as they are.

## Non-goals

- Steering, messaging, or resuming a subagent from the UI. Read-only.
- Matching `v2`'s eventual wire format (`_meta['opencode/child-session']`,
  namespaced tool-call ids, the `opencode/session/child_update` extension
  method). That shape is unshipped and may still change; this design invents
  its own, simpler, all built client-side off raw session events.
- Recursive-subagent depth beyond whatever `subagent_depth` (opencode's own
  config, default `1`) already allows. The discovery mechanism below handles
  deeper nesting for free if a user raises that config, but nothing here
  special-cases it.
- Fixing every other ACP-opencode bug the research surfaced (bash command
  title truncation in Zed, etc.) — only the two that block this feature.

## Design

### 1. Connection: a second SDK client to the same server

`OpenCodeProvider.start()` currently spawns `opencode acp` with no network
flags. It gains:

- A pinned `--port`/`--hostname 127.0.0.1`. `opencode acp`'s own port
  defaults to `0` (OS-assigned) and is never printed anywhere reachable over
  stdio — ACP mode is silent about it — so we must choose it ourselves
  before spawning, the same "guess a free ephemeral port, retry on
  collision" shape `self-control-mcp-server.ts`'s `listen()` already uses
  (`PORT_MIN`/`PORT_MAX`/`PORT_ATTEMPTS`). The difference: we don't own the
  bind here, `opencode acp` does, so a collision surfaces as the whole
  process failing to start (`AcpChild.onFailure`) — caught and retried with
  a new port, bounded attempts, same as today's spawn-failure handling.
- An injected `OPENCODE_SERVER_PASSWORD` in the child's env (merged the same
  way `mergedEnv()` already merges instance overrides), a random per-run
  token — mirrors `SelfControlMcpServer`'s own `randomBytes(24).toString('hex')`
  token pattern. Without one, the server has no auth at all
  (`ServerAuth.headers()` returns `undefined` when unset) — setting our own
  guarantees we always know the credential rather than depending on the
  user's own opencode config being unset.

Once spawned, a new `src/providers/opencode/subagent-watch.ts` opens a
`@opencode-ai/sdk` client at `http://127.0.0.1:<port>` with that token as
`Authorization: Basic <base64>`, and subscribes `sdk.global.event()`.
Connection is retried with backoff — the HTTP server binds before the ACP
stdio handshake starts responding, but there's no ordering guarantee we can
observe from outside.

### 2. Discovery: watch what our own session spawns

The watcher holds `watched: Set<sessionId>`, empty until told the root id.
`AcpRun` gains a small **generic** hook — not opencode-specific — on
`AcpRunOptions`:

```ts
onSessionId?: (id: string) => void
```

fired once, right where `startInner()` already sets `this.sessionId`. The
provider wires this straight to `watcher.setRootSessionId(id)`, which seeds
`watched`.

On every `session.created` event from the raw stream, if `parentID` is in
`watched`, the new id joins it too. This is the whole discovery mechanism —
no explicit depth tracking, no polling `task_id`/metadata off the ACP wire
(which, checked directly in `acp/tool.ts`, only carries the child's session
id on the **completed** frame — too late to watch anything live). Scales to
whatever `subagent_depth` allows for free, because it's just "is this
session's parent one I already care about."

### 3. Mapping: a raw-event tool mapper, parallel to today's

A new `src/providers/opencode/map-subagent-tools.ts` classifies opencode's
raw session events — `session.tool.input.started` / `.called` / `.success` /
`.failed`, `session.text.delta` — into the same canonical `ToolCall`/
`AgentEvent` shapes `map-tools.ts` already produces from the ACP-projected
versions. Same tool-name classification rules (`toToolKind`-equivalent),
different input shape, since these are opencode's internal event names, not
ACP's `tool_call`/`tool_call_update`.

Every event the watcher emits for a watched (non-root) session id carries
`parentId` set to the **parent's own `task` tool-call id** — the field
`AgentEvent`'s `tool-start`/`tool-update`/`tool-end`/`permission` variants
already have, and `agent-session.ts` already nests children through
(`childrenByParent`, `parentItemIdFor`, `resolveParent`) for Claude's
sidechain and Codex's rejoined-thread cases. No new nesting mechanism —
this is the third provider to use the one that exists.

### 4. Merging into the run

`AcpRunOptions` gains a second generic hook:

```ts
childEvents?: AsyncIterable<AgentEvent>
```

`AcpRun` pumps it into its own `EventChannel` (`this.events.push(event)`) in
a background loop started alongside `startup`. The opencode provider passes
`watcher.events` (an `EventChannel`, same house idiom `AcpRun`/`CodexRun`
both already use). Neither `acp-run.ts` nor `map-updates.ts` gains any
opencode-specific code — the hook is vendor-neutral, only opencode supplies
one today.

A watched child session closes its nested card on
`session.execution.succeeded | failed | interrupted` for that id — the
watcher emits the matching `tool-end` for the subagent's own `tool-start`
(the one the parent's `task` tool call already produces via the existing
ACP path) at that point, and drops the id from `watched`.

### 5. Permission relay for watched children

`AcpRun` gains one new public method, reusing machinery it already has:

```ts
handleAuxiliaryPermission(id: string, tool: ToolCall, meta?: PermissionMeta):
  Promise<ToolDecision | undefined>
```

Same body as today's `onRequestPermission`'s parking logic — `autoDecision(
this.mode)` first (so `bypass`/`dontAsk` on the **parent** session apply to
its subagents too, per the earlier product decision: inherit, don't add a
second mode control), and only if that's `undefined` does it park a real
promise in the same `this.parked` map and push a `permission` `AgentEvent`
(with `parentId` set to the owning subagent's tool-start id, so the approval
card nests under the subagent, same place its tool calls do).

The watcher calls this for every `permission.asked` whose `sessionID` is in
`watched`, using a namespaced id (`${childSessionId}:${rawRequestId}`) so it
can never collide with a same-shaped id from the main thread's own tool
calls. Because it shares `this.parked`, the existing
`AgentRun.respondToTool(id, decision)` path — already wired end-to-end
through `agent-session.ts` and the webview's approval card — answers a child
permission with **zero** new UI code. Once `handleAuxiliaryPermission`
resolves, the watcher translates the `ToolDecision` into opencode's own
`sdk.permission.reply({ requestID, reply: 'once'|'always'|'reject',
directory })` — the same call `acp/permission.ts` makes internally, just
invoked directly instead of relayed through the broken registry gate.

### 6. Cleanup

A third generic hook, `onDispose?: () => Promise<void> | void`, fired inside
`AcpRun.dispose()` alongside its own teardown. The provider wires it to
`watcher.close()` (closes the second SDK connection; the spawned
`opencode acp` child itself is still killed by `AcpRun.dispose()`'s existing
`child.kill()` — one process, one lifetime, regardless of how many
connections point at it).

No persistence anywhere in this feature — `watched`, the SSE subscription,
and every nested transcript item's live state exist only for the run's
lifetime, consistent with the project's standing rule that a restored claim
about a live process describes an install nobody checked this launch.

## Error handling

- Port reservation collision → retry spawn with a new port, bounded
  attempts, same shape as `self-control-mcp-server.ts`'s `PORT_ATTEMPTS`.
- Second SDK connection fails to connect or drops mid-session → the feature
  degrades to today's behavior (parent's own `task` card, no nested
  children, no child permission relay) rather than failing the run. The
  primary ACP connection is unaffected either way — this is a supplemental
  tap, not a dependency of the main conversation.
- A `permission.asked` for a session not in `watched` (e.g., a session this
  server is running for an entirely different client) is ignored — `watched`
  is the whole authorization boundary for which sessions this run will ever
  answer permissions for.

## Testing

- `subagent-watch.test.ts`: discovery (`session.created` → `watched` only
  when parent matches), event correlation (`parentId` set correctly, nested
  under the right tool-start), terminal-status card closing, permission
  relay (`handleAuxiliaryPermission` decision → correct `sdk.permission.reply`
  call), auto-decision inheritance from the parent's mode.
- `map-subagent-tools.test.ts`: same fixture-style coverage `map-tools.test.ts`
  already has, against the raw `session.tool.*` shapes instead of ACP's
  projected ones.
- `acp-run.test.ts`: the three new generic hooks (`childEvents` merges into
  `events`; `onSessionId` fires once, with the right id; `onDispose` fires
  during `dispose()`) — exercised with a fake auxiliary source, no opencode
  specifics required, proving the hooks stay vendor-neutral.
- `opencode-provider.test.ts`: spawn args carry the pinned port and injected
  password; a port collision triggers a bounded retry.

## Open questions

- Exact bounded-retry count for port collisions — the implementation plan
  can pin a number against `self-control-mcp-server.ts`'s existing
  `PORT_ATTEMPTS = 5` unless testing suggests otherwise.
- Whether `sdk.session.message()`/`@opencode-ai/sdk` needs to be added as a
  new `package.json` dependency or can be dynamically imported the way
  `acp-client.ts` already handles the ESM-only ACP SDK — the implementation
  plan resolves this against the SDK's actual module format.
