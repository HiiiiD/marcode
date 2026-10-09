# Marcode daemon

## Problem

Every client (each VS Code window, the TUI) runs its own `createHost`. A session is owned by
one host through its lease; every other client sees it as dormant and read-only
(`dormant-provider`, `foreign-tail`, `roster-sync`). A running turn dies when its window
reloads or closes. Transcripts survive; the agent does not.

This reverses the "no daemon" non-goals in the VS Code design, the shared-storage spec and
the TUI spec. Those specs deferred it because the core had to become vscode-free first. It is.

## Goals

- One live host per workspace directory, shared by the extension and the TUI. A session
  running in one client is fully usable from the other.
- Agents survive a window reload or a TUI exit.
- Webviews, reducers and `MessageRouter` do not change contract.
- If the daemon cannot start or attach, the client runs today's in-process host.

## Non-goals

Remote or TCP access, multi-user daemons, cross-machine sessions, forced takeover of a
foreign session, browser clients.

## Decisions

| Question | Decision |
|---|---|
| Outlives clients? | Yes, detached; exits after an idle timeout |
| Version skew | `PROTOCOL_VERSION` integer decides compatibility; an incompatible daemon is replaced only when idle |
| Transport | Windows named pipe / unix socket, NDJSON, plus a token in the handshake |
| Fallback | In-process host plus leases, kept for the first release |
| Scope | One daemon per workspace directory (`~/.marcode/workspaces/<slug>`) |

The pipe was spiked on Windows with Node 22.22 and Bun 1.3.5: server and client in all four
Node/Bun combinations round-tripped NDJSON. Not covered: a `bun build --compile` binary and
unix sockets. Both are in the test plan. Default pipe ACLs are not relied on for auth, hence
the token.

## Architecture

```
daemon process                            clients
  createHost (hostKind 'daemon')            extension surfaces ─┐ DaemonTransport
  DaemonServer                              TUI               ─┤ implements ClientTransport
    per connection:                                            ─┘
      MessageRouter(manager, emit -> socket, proxy hooks)
      PostBus client (wants chosen by clientKind)
```

- `DaemonServer` accepts a socket, requires `hello` first, then builds a `MessageRouter` for
  that connection with `emit` wired to the socket, and registers it on the daemon-side
  `PostBus` with the `wants` predicate for its `clientKind`.
- Each extension surface (sidebar, review, fleet, history) opens its own connection, so
  existing per-surface gating carries over unchanged.
- `hostKind` and `LeaseHost` gain `'daemon'`.
- `workspaceRoots()` is the union of attached clients' `roots`; while nobody is attached it
  falls back to the roots the daemon was started with (`--root`), not the last union. Recall
  scoping already picks the innermost folder containing a session's cwd.

## Wire protocol

Types in a new types-only `src/protocol/daemon-wire.ts`. Runtime constants (`PROTOCOL_VERSION`,
framing, handshake) in `src/daemon/`. `messages.ts` stays types-only and unchanged in shape.

| Frame | Direction | Purpose |
|---|---|---|
| `hello {protocolVersion, appVersion, clientKind, token, roots, defaultCwd}` | C to D | First frame. `clientKind`: `sidebar`, `review`, `fleet`, `history`, `tui` |
| `welcome {protocolVersion, appVersion, clientId, loginRecipes}` / `reject {reason, daemon}` | D to C | `reason`: `protocol-mismatch`, `bad-token`, `upgrade-busy`, `bad-hello`. `loginRecipes` because the TUI's login hint derives from daemon-side config |
| `msg {m}` | both | A `WebviewToHost` or `HostToWebview` message, unchanged |
| `act {op, args}` | D to C | One-way client-local work: `reveal`, `openDiff`, `openSettings`, `openExternal`, `exportCsv`, `exportImage`, `login`, `setFavoriteModels` |
| `req {id, op, args}` / `res {id, result or error}` | D to C / C to D | Only `pick` and `search`, which need an answer. 30s ask timeout; a timeout or failure is state |
| `ctx {ctx}` | C to D | Editor context, pushed by the client right after `welcome` and on change |
| `shutdown {token}` -> `bye` / `refuse {busy or bad-token}` | C to D | Version replacement and `--stop`; refused while busy. Accepted before `hello`, since a client of an incompatible version is rejected at `hello` and must still be able to replace an idle daemon |

- A malformed line closes the connection. An unknown frame type is ignored (debug log), so
  additive changes need no bump. Only a breaking change bumps `PROTOCOL_VERSION`.
- Order is preserved per connection. A client more than ~32MB behind is dropped and recovers
  by reconnecting and re-hydrating.

### Client-local hooks

`MessageRouter` takes `EditorContextHost`, `AttachmentHost.pick`, `FileSearch` and `ConfigHost`
by injection. In the daemon each connection gets proxies: `pick` and `search` become `req`/`res`,
fire-and-forget calls become `act`, and `EditorContextHost.current()` (synchronous) serves the last
`ctx` the client pushed. The client answers with its real VS Code or terminal implementation.
The router is unchanged and the host imports nothing client-specific.

### Direct manager calls become messages

`canOpenFile`, `attachmentPath`, `layout`/`setLayout` and the memory status/estimate/reindex
calls are made directly on the manager today. Each gets a typed request/reply pair in
`messages.ts`; session-scoped ones carry a `SessionId`. The TUI needed only `attachmentPath`, which
shipped as `request-attachment-path {id, attachmentId, itemId?, reqId}` / `attachment-path {reqId,
path}` (the TUI treats a 5s silence as "attachment not found"); the rest arrive with the extension.

## Lifecycle

- **Discovery:** `<workspaceDir>/daemon.json` = `{pid, endpoint, token, protocolVersion,
  appVersion, startedAt}`, written atomically once listening, user-only permissions.
- **Attach:** read `daemon.json`, check pid alive, connect. A dead pid or a refused connect
  (`ECONNREFUSED`/`ENOENT`) marks the record stale and means spawn. A handshake **timeout** never
  does: a record on disk means that daemon got as far as listening, so a silent one is blocked, not
  gone. The client waits and, if it never answers, falls back with reason `unresponsive-daemon`.
- **Spawn lock:** spawns are serialized by an `O_EXCL` `daemon.lock` (pid + time; stale when the
  pid is dead or after 30s). Taking over a stale lock is itself serialized through an `O_EXCL`
  `daemon.lock.takeover`, so two clients judging the same stale lock cannot both win. The lock is
  held until the spawned daemon answers.
- **Handshake:** a connection that sends no `hello` within 10s is dropped. Only attached
  connections count as clients for idle exit.
- **Single owner:** `runDaemon` refuses to start while `daemon.json` names another live pid (on
  POSIX `listen()` would otherwise unlink a live daemon's socket). On POSIX the socket directory is
  vetted before listening: not a symlink, owned by this user, mode tightened to 0700.
- **Spawn:** the extension runs `process.execPath` with `ELECTRON_RUN_AS_NODE=1` on bundled
  `dist/daemon.js`, detached, stdio ignored. The TUI binary runs `marcode daemon`. Both call
  the same `createHost` wrapper.
- **Version:** an incompatible `hello` is rejected with a typed error. If the daemon is older
  and idle the client sends `shutdown`, waits for exit and spawns its own build. If busy, the
  client falls back and surfaces "update or close sessions". A client never replaces a daemon
  whose `protocolVersion` is newer than its own; it falls back and says to update.
- **Busy:** the daemon is busy if any session status is not `idle` and not `error`. A
  background task keeps a session `running` (`agent-session.ts` `recomputeWaitingStatus`), so
  background subagents are covered. A session parked on an approval with no client attached
  also keeps the daemon alive; that is correct, killing it would lose the turn.
- **Idle exit:** after `daemon.idleMinutes` (default 10) with zero clients and not busy. A
  client attaching resets the timer. Exit releases leases and removes `daemon.json`.
- **Crash:** clients see the socket close, show a reconnecting state, re-attach or respawn,
  and re-run `hydrate`. A prompt or draft typed while reconnecting is queued (50 max) and sent
  after the re-`ready`. Sessions that were mid-turn come back `error` with a transcript item.
- **Provider caveat:** a provider that never reports its long-running work as non-idle would
  look idle to the daemon. That is a provider bug the daemon exposes; each provider gets a test.
  Shipped state: Claude reports background tasks after `turn-end`; OpenCode's task subagents run
  inside the turn; a Codex subagent thread that outlives its parent turn is not reported (open bug).

## Client changes

- `src/daemon-client/` (no `vscode`): `connectOrSpawn({workspaceDir, clientKind, roots, hooks,
  spawn})` and `DaemonClient` (shipped name of `DaemonTransport`), a `ClientTransport`. Owns
  discovery, spawn lock, handshake, version policy, reconnect and re-hydrate.
- **Extension:** `activate()` tries `connectOrSpawn`; on failure, today's `createHost` path
  and a one-line notice. `MessageRouter` and `PostBus` gating live daemon-side. Webviews and
  reducers are untouched.
- **TUI:** `bootHost` swaps its loopback for the `DaemonClient`, same fallback.
- **CLI:** `marcode daemon`, with `--status` (exit 1 when none is running) and `--stop` (exit 0
  when none is running, 1 when refused, unreachable or not responding). `src/daemon/daemon-main.ts`
  is the JSX-free entry, loadable by plain Node, that the extension's `dist/daemon.js` will use.
- **Config** (`config.json`, `docs/config.md`): `daemon.enabled` (default true),
  `daemon.idleMinutes` (default 10). Disabled means a plain in-process host.

## Testing

- **Unit (mocha):** framing and partial lines; handshake accept/reject; version-by-busy
  matrix; idle timer and busy rule including a background task; spawn lock; stale
  `daemon.json` recovery.
- **Integration:** real pipe, in-process daemon, two fake clients: fan-out gating by
  `clientKind`, `req`/`res` timeouts, slow-client drop; kill the daemon mid-turn and check
  reconnect plus `error` transcript item.
- **Cross-runtime:** Node daemon with Bun client and the reverse; one test with the compiled
  `bin/marcode`.
- **Existing DOM and TUI suites pass unchanged**; that is the check the webview contract
  did not move.
- **Per-provider:** Claude, Codex and OpenCode long-running background work reports non-idle.

## Rollout

1. Core: wire types, server, `daemon-client`, `marcode daemon`, integration tests; no client changes.
2. TUI first (smaller surface, real use before the extension depends on it).
3. Extension with fallback. After a soak, a follow-up may remove the in-process path and the
   lease, dormant-provider, foreign-tail and roster-sync modules.

## Invariants this adds

- The daemon is `createHost` plus a transport; it imports no `vscode`.
- A client never touches a session's JSONL or the manager directly when a daemon is attached.
- Every request frame is answered or times out; nothing rejects across the socket.
