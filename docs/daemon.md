# Marcode daemon

The daemon is a detached background process that owns one workspace's host: the same `createHost`
the TUI would otherwise run in-process, plus a local socket that clients attach to. Because the
agents run in the daemon rather than in the client, quitting the TUI no longer stops them, and the
next client to attach sees the same sessions still running.

There is one daemon per workspace directory (`~/.marcode/workspaces/<slug>`). The TUI and the
VS Code extension both attach to it, so a session running in one is live in the other. When a client
cannot use the daemon it runs its own host and shows daemon-owned sessions read-only
("Running in daemon (pid …)"), the same as any other foreign lease.

## Lifecycle

- **Spawn.** When the TUI starts and finds no live daemon, it takes the spawn lock, starts
  `marcode daemon --serve --workspace-dir <dir> --root <git root>` detached (the compiled binary
  runs itself; under Bun the script re-runs its own entry), and attaches once `daemon.json` appears.
  Two clients starting together produce one daemon: the second waits on the lock and attaches.
- **Attach.** The client reads `daemon.json`, checks the pid, connects and sends `hello` with the
  token. The daemon answers `welcome` and then serves the client exactly like the in-process router.
- **Reconnect.** If the link drops, the TUI shows "Reconnecting to the background host…", retries
  with backoff (respawning if the daemon is gone), re-hydrates and re-sends the panes it shows. A
  prompt or draft typed while reconnecting is queued and delivered after the reconnect. After a
  daemon crash, sessions restored from disk come back `idle`; a turn the crash cut short is not
  resumed or marked. After the retries run out it shows
  "Lost the background host; restart marcode".
- **Idle exit.** With no attached client and no busy session for `daemon.idleMinutes`, the daemon
  exits. Busy means any session not `idle` and not `error`: a running turn, a pending approval, or
  a background task the provider still reports (see [Provider caveat](#provider-caveat)). Exiting
  releases the leases and removes `daemon.json`.
- **Upgrade.** A client compares its `PROTOCOL_VERSION` with the daemon's.
  - Same version: attach.
  - Daemon older and idle: the client asks it to shut down, waits for it to exit, and spawns its own.
  - Daemon older and busy: left alone; the client falls back to in-process.
  - Daemon newer: never replaced; the client falls back and says to update.
- **Config change.** `daemon.json` records a signature of the `config.json` the daemon started
  with. A client whose `config.json` differs replaces an idle daemon the same way as an older one;
  a busy one is attached anyway, with the notice "The background host is running with an older
  config.json; run `marcode daemon --stop` once sessions finish". This check runs only when a client
  starts; a reconnect attaches to whatever daemon it finds.
- **Unresponsive.** A daemon whose record is live but that accepts and never answers is waited on
  and never replaced. Only a refused connect (nobody listening) marks a record stale.

## VS Code extension

- **Spawn.** The extension runs its bundled `dist/daemon.js` with `process.execPath` and
  `ELECTRON_RUN_AS_NODE=1`, detached, logging to `daemon.log`. Checked against VS Code's Electron 42 / Node 24:
  the bundle starts, `node:sqlite` has FTS5, and `memory.sqlite` is created.
- **Connections.** One per surface: the sidebar at activation, and the Changes, Fleet and History tabs when they
  open or are restored. A window's mode (daemon or in-process) is decided once, by the sidebar connection.
- **Reload.** Closing or reloading a window closes its sockets only; running turns continue and the next window
  re-hydrates. A dropped link shows "Reconnecting to the background host…" in the sidebar, then
  "Lost the background host; reload the window" if the retries run out.
- **Fallback.** When the daemon cannot be used the window runs the host in-process and shows
  `Running without the background host: <reason>` once. `daemon.enabled = false` does the same silently.
- **Notices.** Daemon-side warnings, shell-profile noise and "provider update available" reach the sidebar of
  every attached window as `notify` / `shellNoise` acts, and are logged to `daemon.log`. Warnings raised before any
  window is attached appear only in the log.
- **Stale builds.** With the same protocol, an idle daemon whose app version is older than the client's is replaced;
  a busy one is attached with a notice; a newer one is never replaced. Dev or prerelease versions are left alone.
- **Settings the daemon cannot see.** `marcode.showCacheTimer` is stamped onto `hydrate` by the sidebar.

## Files

All in the workspace directory.

| File | Purpose |
|---|---|
| `daemon.json` | `{pid, endpoint, token, protocolVersion, appVersion, startedAt, configSignature}`, written atomically once listening, user-only permissions. Removed on clean exit |
| `daemon.lock` | Spawn lock (`O_EXCL`), held by the spawning client until the daemon answers; if it never answers in time the lock is kept until it goes stale, so a slow boot cannot get a rival. A lock whose pid is dead, or older than 30 s, is taken over |
| `daemon.lock.takeover` | Short-lived marker that serializes the takeover of a stale `daemon.lock` |
| `daemon.log` | The daemon's stdout/stderr and its own lines: `listening on …`, `shutdown requested`, `idle; exiting`, `stopped`, `startup failed: …` |

The endpoint is `\\.\pipe\marcode-<hash>` on Windows and `<tmpdir>/marcode-<uid>/<hash>.sock`
elsewhere (directory 0700, socket 0600). The token in `daemon.json` is what authenticates a client;
default pipe ACLs are not relied on.

## Commands

| Command | Output | Exit code |
|---|---|---|
| `marcode daemon --status` | `running pid=… protocol=… started=…` or `not running` | 0 running, 1 not running |
| `marcode daemon --stop` | `stopped`, `not running`, `refused: busy`, `unreachable` or `not responding` | 0 stopped or not running, 1 otherwise |
| `marcode daemon --serve --workspace-dir <dir> [--root <dir>]…` | nothing; logs to `daemon.log` | what the TUI spawns; not meant to be run by hand |

`--status` and `--stop` act on the daemon for the current directory's git root. `--stop` refuses
while a session is busy; finish or interrupt it first.

## Config

In `~/.marcode/config.json` (see `config.md`):

| Key | Default | Effect |
|---|---|---|
| `daemon.enabled` | `true` | `false` makes the TUI run its host in-process, as before |
| `daemon.idleMinutes` | `10` | Minutes with no client and nothing busy before the daemon exits. A running daemon keeps the value it started with until it is replaced (see Config change) |

## Daemon or in-process

When the TUI cannot use a daemon it runs the host in-process and its first notice line says
`Running without the background host: <reason>`, for example a newer daemon, a busy older one, a
daemon that is not responding, or a spawn that failed. That notice comes first, ahead of any
`config.json` warning. No such notice means the TUI is attached.
`marcode daemon --status` from the same directory confirms it. `marcode login` always runs
in-process and never starts a daemon.

## Several clients

Each attached client has its own set of shown panes, and the daemon shows the union of them: a
second terminal attaching never hides, discards or digests a session the first one shows, and a
session becomes hidden (stored and recallable in memory) only when no client shows it. When the last client leaves,
the last union stays as it was. The persisted pane layout is shared and last-writer-wins: each
client restores whatever layout was saved last, by any of them.

## Quitting the TUI

Quitting closes the TUI's connection only. Running turns, pending approvals and background tasks
keep going in the daemon; start `marcode` again to pick them up. The daemon keeps its session leases
until it exits, so VS Code shows those sessions read-only ("Running in daemon") for up to
`daemon.idleMinutes` after the last client quits. To stop everything, quit and run
`marcode daemon --stop` (or interrupt the sessions first if it answers `refused: busy`).

## Provider caveat

The daemon's idle check trusts a session's status. Claude reports background tasks after a turn
ends, and Codex reports a subagent thread whose turn is still in flight the same way. OpenCode's
subagents finish inside the turn; this assumes `opencode acp` has no work left once it answers
`end_turn`.

## Troubleshooting

- **The TUI says it is running without the background host.** Read the reason, then
  `daemon.log` in the workspace directory.
- **`not responding`.** The daemon accepted the connection but never answered. Check `daemon.log`;
  if it is truly stuck, kill the pid from `marcode daemon --status`. The next client finds the dead
  pid and starts a fresh daemon.
- **A leftover `daemon.lock` or `daemon.json`.** Harmless once its pid is dead: the next client
  takes over the lock and replaces the record. Delete them by hand only when no `marcode` daemon
  process is running.
- **`startup failed: a daemon is already running`** in `daemon.log`. A second daemon refused to
  start beside a live one; the client attaches to the first.
