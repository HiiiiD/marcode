# Marcode daemon

The daemon is a detached background process that owns one workspace's host: the same `createHost`
the TUI would otherwise run in-process, plus a local socket that clients attach to. Because the
agents run in the daemon rather than in the client, quitting the TUI no longer stops them, and the
next client to attach sees the same sessions still running.

There is one daemon per workspace directory (`~/.marcode/workspaces/<slug>`). Today only the TUI
attaches to it; the VS Code extension still runs its own host and shows daemon-owned sessions
read-only ("Running in daemon (pid …)"), the same as any other foreign lease.

## Lifecycle

- **Spawn.** When the TUI starts and finds no live daemon, it takes the spawn lock, starts
  `marcode daemon --serve --workspace-dir <dir> --root <git root>` detached (the compiled binary
  runs itself; under Bun the script re-runs its own entry), and attaches once `daemon.json` appears.
  Two clients starting together produce one daemon: the second waits on the lock and attaches.
- **Attach.** The client reads `daemon.json`, checks the pid, connects and sends `hello` with the
  token. The daemon answers `welcome` and then serves the client exactly like the in-process router.
- **Reconnect.** If the link drops, the TUI shows "Reconnecting to the background host…", retries
  with backoff (respawning if the daemon is gone), and re-hydrates. A prompt or draft typed while
  reconnecting is queued and delivered after the reconnect. After the retries run out it shows
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
- **Unresponsive.** A daemon whose record is live but that accepts and never answers is waited on
  and never replaced. Only a refused connect (nobody listening) marks a record stale.

## Files

All in the workspace directory.

| File | Purpose |
|---|---|
| `daemon.json` | `{pid, endpoint, token, protocolVersion, appVersion, startedAt}`, written atomically once listening, user-only permissions. Removed on clean exit |
| `daemon.lock` | Spawn lock (`O_EXCL`), held by the spawning client until the daemon answers. A lock whose pid is dead, or older than 30 s, is taken over |
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
| `daemon.idleMinutes` | `10` | Minutes with no client and nothing busy before the daemon exits. A running daemon keeps the value it started with |

## Daemon or in-process

When the TUI cannot use a daemon it runs the host in-process and its first notice line says
`Running without the background host: <reason>`, for example a newer daemon, a busy older one, a
daemon that is not responding, or a spawn that failed. No such notice means the TUI is attached.
`marcode daemon --status` from the same directory confirms it. `marcode login` always runs
in-process and never starts a daemon.

## Quitting the TUI

Quitting closes the TUI's connection only. Running turns, pending approvals and background tasks
keep going in the daemon; start `marcode` again to pick them up. To stop everything, quit and run
`marcode daemon --stop` (or interrupt the sessions first if it answers `refused: busy`).

## Provider caveat

The daemon's idle check trusts a session's status. Claude reports background tasks after a turn
ends; OpenCode's subagents finish inside the turn. A Codex subagent thread that outlives its parent
turn is not reported yet, so a daemon with no client attached could exit under it.

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
