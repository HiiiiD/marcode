# Self-control tools — design

## Scope

Let an agent running inside a Marcode session drive the extension itself: spawn a new
session (provider, model, mode, cwd) and hand it an initial prompt, from a tool call in
its own conversation. v1 is spawn + delegate only — no read-back (roster listing, status,
session output), no session control (model/mode switch, close, delete). Those are
explicitly deferred, not designed here.

Covers all three backends this project runs today: Claude Agent SDK (in-process) and the
two ACP backends, Codex and OpenCode (child process, real MCP protocol).

Out of scope: a general-purpose MCP server users can point their own tools at; anything
beyond the one `spawn_session` tool; UI surface for this (no new webview affordance —
spawned sessions appear in the roster exactly like a manually created one).

## Mechanism

One loopback HTTP MCP server, owned by the extension host, started at `activate()` and
shared by every session regardless of backend. This is a deliberate uniform-mechanism
choice over the alternatives:

- **In-process SDK-only tool** (`createSdkMcpServer()` + `tool()`, passed via the Claude
  Agent SDK's `mcpServers` option) is the simplest path for the Claude backend — a plain
  function call, no network hop, no process. But it has no ACP equivalent: an ACP agent
  only takes real MCP server configs its own CLI connects to. Two backends would mean two
  independently-implemented tool surfaces.
- **A spawned stdio MCP server** would work for both, but costs a child process per
  session (or a shared child process with its own lifecycle to manage) for zero benefit
  over a single long-lived HTTP server.
- **Chosen: single loopback HTTP MCP server.** Both wire protocols already speak the same
  `McpServer` shape for an HTTP transport — the Claude Agent SDK's `mcpServers` option
  accepts `McpHttpServerConfig` (`{type:'http', url, headers}`), and ACP's
  `NewSessionRequest.mcpServers` accepts the same shape (`McpServerHttp & {type:'http'}`,
  confirmed in `@agentclientprotocol/sdk`'s generated schema). One server, one tool
  implementation, one code path both backends point at identically.

## Components

- **`src/host/self-control-mcp-server.ts`** (new). No `vscode` import — same
  unit-testability rule as `message-router.ts`. Responsibilities:
  - Bind an HTTP server to `127.0.0.1` on a random free port at construction.
  - Generate a per-launch random bearer token.
  - Register one MCP tool, `marcode__spawn_session` (namespaced to avoid colliding with a
    user's own MCP servers), via `@modelcontextprotocol/sdk`'s `McpServer` +
    `StreamableHTTPServerTransport`.
  - Tool input: `provider`, `model`, `mode`, `cwd`, `prompt`. Handler validates against
    `SessionManager.catalog()`, then calls `SessionManager.create(...)` followed by the
    same send-message path `MessageRouter` uses for a user-typed first message. Returns
    `{sessionId}` on success.
  - Exposes `{port, token}` (or a ready-to-use `McpServerHttp` config object) for
    `extension.ts` to hand to `SessionManager`.
  - `dispose()` closes the HTTP server (called from `deactivate()`).

- **`extension.ts`**: construct `SelfControlMcpServer` right after `SessionManager`, pass
  its config down so `SessionManager` can stamp it onto every session it starts.

- **`ClaudeProvider`**: extra `mcpServers` entry merged into whatever `mcpServers` the SDK
  query options already carry.

- **`AcpRun`**: today `newSession({ cwd, mcpServers: [] })` hardcodes empty — see the
  comment there noting that parameter is for client-injected servers, deliberately left
  empty to avoid duplicating the agent's own configured servers. This becomes
  `mcpServers: [selfControlEntry]` — the one addition that parameter was always meant to
  carry; the user's own servers still load from the agent's own config, unaffected.

## Data flow

1. `activate()` starts `SelfControlMcpServer`, gets back its loopback config.
2. `SessionManager` holds that config and includes it when constructing every session's
   provider options, regardless of backend.
3. Inside a running session, the agent calls `marcode__spawn_session`.
4. MCP client (SDK or ACP agent's own MCP client) POSTs to the loopback server with the
   bearer header.
5. Handler validates token and inputs, calls `SessionManager.create()` + delegates the
   prompt — the exact path the UI's "new session" affordance already uses.
6. New session joins the roster normally; `sessions-changed` fans out to visible clients
   same as any manual creation. No special-casing in the webview or protocol layer.

## Error handling

- Missing/incorrect bearer token → HTTP 401, no `SessionManager` call made.
- Unknown `provider`/`model`/`mode`, or `cwd` outside anything the extension is allowed to
  touch → MCP tool error content (`isError: true` with a message), not a thrown exception
  — keeps the "errors are state" spirit at this new boundary too, even though it isn't a
  transcript item this time.
- Port bind failure at startup → retry a couple of random ports; if still failing, log and
  skip wiring self-control for this launch entirely (sessions start without the extra
  `mcpServers` entry rather than the extension failing to activate).
- `deactivate()` closes the HTTP server; no orphaned listener across a reload.

## Testing

- Unit test the tool handler as a pure function against a fake `SessionManager`: asserts
  `create()` called with the right args on success, and each validation failure path
  returns tool error content rather than throwing.
- One real-HTTP-round-trip unit test: start the server on an ephemeral port, POST a tool
  call with and without the correct bearer token, assert the responses.
- Extend existing `ClaudeProvider` and `AcpRun` unit tests to assert the extra
  `mcpServers` entry appears in the options/array passed to the SDK/ACP connection when a
  self-control config is supplied, and is absent when it isn't (e.g. server failed to
  bind).

## Deferred (not this spec)

- Read-back tools: list roster, read a session's status/last output.
- Session control tools: switch model/mode, close, delete.
- Any wiring for a user's own external MCP clients to reach this server — it exists only
  for agents running inside Marcode's own sessions.
