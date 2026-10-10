# `!` shell commands in the composer

A composer line starting with `!` runs as a shell command in the session's working directory, in the TUI and
in the extension sidebar, with no model turn. The command and its output become a transcript item, so they are
persisted and shown on every client. It is never sent to the model.

## Decisions

| Question | Decision |
|---|---|
| Where it runs | The host (daemon or in-process), in the session's `cwd`. A client never spawns it |
| Persistence | A `shell` transcript item in the session JSONL; survives reload and reconnect |
| Who sees it | Every client showing the session, through ordinary transcript patches. No reply messages |
| Model visibility | None. The model never sees it; the user pastes output into a prompt if needed |
| Permissions | None. The user typed it; it sits outside the permission modes, same as in Claude Code |
| Agent access | None. Accepted from client connections only; never from `marcode__*` or any provider path |
| Foreign sessions | Refused, like every mutator |
| Shell | `bash` by default; `shell.aliases` in config select others (`!pwsh ...`) |

## Wire

`src/protocol/messages.ts`, types only. Both messages carry the `SessionId`.

```
WebviewToHost:
  { t: 'run-shell';    id: SessionId; command: string }
  { t: 'cancel-shell'; id: SessionId; itemId: string }
```

There is no reply message: the host appends and updates the transcript item, and the existing
`session-patch` fan-out carries it to the visible sessions. Both tags are added to `KNOWN_MESSAGE_TAGS` in
`message-router.ts`, the allow-list of tags the router accepts; an unlisted tag is dropped.
`wantsFor` and the review/fleet/history allow-lists need no change, since `session-patch` was never theirs.

### Transcript item

```
| (ItemBase & {
    role: 'shell'; command: string;
    state: 'running' | 'done' | 'cancelled';
    output: string;                       // stdout and stderr interleaved in arrival order
    exitCode?: number; signal?: string;
    truncated?: boolean; timedOut?: boolean; error?: string;
  })
```

`command` is the text after `!`, exactly as typed (alias token included), so the card reads like the line the
user wrote. Interleaving keeps it one string; the cost is that a client cannot colour stderr. Accepted for now.

## Host

New `src/host/shell/` folder: `shell-runner.ts` (spawn, limits, kill), `shell-aliases.ts` (resolve and
validate), and `shell-controller.ts` (one session's run). No `vscode` import. Pure Node `child_process.spawn`.
The router case is inline and thin; the session owns the item.

- **Session ownership:** `AgentSession.runShell(command)` appends a `running` item, starts the runner, and
  updates the item as output arrives. The process belongs to the session, not to the connection that asked, so
  a client dropping or a daemon-attached window reloading does not kill it, and any client can cancel it.
- **Streaming into the transcript:** output is coalesced and written with a `replace` patch at most every
  250ms, then once more on exit. A `replace` carries the whole item, which the output cap keeps small.
- **Persistence cap:** `output` is capped at 64 KiB, keeping the tail and setting `truncated`. The run is not
  killed at the cap; it keeps draining so the process cannot block on a full pipe, and further output is
  dropped. The wall timeout is 120s (`timedOut`, then the tree is killed).
- **Shell:** `bash -c` on every platform. On Windows it resolves Git Bash (`bash.exe` on PATH, then the Git for
  Windows install); if none is found the item ends `done` with an `error` naming the `shell.aliases` setting.
  `windowsHide: true`.
- **Aliases:** if the command's first token, followed by whitespace, matches an alias, the rest of the line is
  run through that alias instead of bash. Resolution is host-side and looks only at that first token, so
  `!bash -c 'pwsh --version'` runs bash and the real `pwsh` on PATH, never the alias.
- **cwd:** the session's `cwd` when the command starts, so a worktree move is honoured. A move while a command
  is running does not retarget it.
- **Cancel:** kills the process tree (`taskkill /T /F` on Windows, the process group on POSIX); the item ends
  `cancelled`.
- **Concurrency:** one running command per session. A second `run-shell` while one is running is refused with
  an `error` transcript item (via `noteError`), not queued. Independent of the turn: a command may run while the
  session is `running`, and session status is untouched.
- **Lifecycle:** dispose or close of the session kills a running command. A `running` item found on load (the
  host died mid-command) is turned into `cancelled` with `error: 'interrupted'`, alongside the existing
  `queued`-relocation fix-up in `session-manager.ts`.
- **Errors are state:** spawn failure becomes `error` on the item. Nothing rejects across the wire.
- **Redaction:** none, matching how tool output is stored today; it is the user's own command in their own cwd.
- **`updatedAt`:** the item goes through `appendItem`/`replaceItem`, so it bumps `updatedAt` like any
  transcript write. That is correct: the session has activity.

Router case: resolve the session, refuse if missing or `isForeign`, then `session.runShell(command)`; the
handler is single-use, so it stays inline.

## What the model sees

Nothing. The item is transcript-only: `AgentSession.deliver` does not read it, and `host/replay.ts` renders it
as a one-line `SHELL:` entry only for fork, handoff and replace-session seeds. The digest and memory index ignore
it. (An earlier draft prepended undelivered output to the next typed prompt, as Claude Code does; it was dropped
because the extra delivery path interacted with slash commands, session takeover and reload priming, and the
user prefers a shell that is for them alone.)

## Config

`shell.aliases` in `~/.marcode/config.json`, read by `createHost` like every host setting (`docs/config.md`,
reload to apply; nested as `shell.aliases`, and `HostConfig.shell.aliases` holds the validated table).

```json
{ "shell": { "aliases": { "pwsh": { "command": "pwsh", "args": ["-NoProfile", "-Command"] } } } }
```

- The line after the alias is appended as the final argument. No shell string-building, so no quoting layer.
- Built-in defaults: `pwsh` (`pwsh -NoProfile -Command`) and `powershell` (`powershell.exe -NoProfile
  -Command`). A user entry with the same name replaces the default; `null` removes it.
- Validation drops malformed entries (non-string `command`, non-string-array `args`, a name with whitespace or
  starting with `-`) and keeps the rest, as the other list settings do.
- An alias whose executable cannot be spawned ends the item with `error`.
- Aliases are host config, never client input: a client cannot define one.

## Composer behaviour

Shared parse in `client-core`: `parseShellCommand(text)` returns the command when the trimmed text starts with
`!` followed by non-whitespace, else `undefined`. A lone `!` and `!!` are sent as ordinary prompts.

- **Submit:** post `run-shell`, clear the box and draft. Nothing is sent to the model and there is no `queued:`
  line. It works while the session is `running`.
- **Mode hint:** while the text starts with `!`, the placeholder and frame tone change to a shell cue
  (`Shell — Enter run`). Cosmetic only.
- **Mentions and slash popups:** closed in shell mode; `@` and `/` mean paths and flags here.
- **Prompt history:** `promptHistory` reads `user` items, so shell lines are not recalled with Up. Out of scope.
- **Busy shell:** while a command is running in this session, submitting another `!` line shows the host's
  refusal item; the composer does not need to track it.

## TUI

A `ShellCard` in `src/tui/ui/transcript/`, built on `panel.tsx` and `tool-blocks.tsx` command/output rendering,
ANSI stripped. Header `$ command`; the output clamped to the last 12 lines while `running`, full after;
footer `running…` / `exit 0` / `exit 1` / `cancelled` / `timed out` / `truncated`. Esc while the composer is
empty and a command is running posts `cancel-shell`, routed through `keymap.ts` like the other bindings. The
spinner uses `use-ticker.ts`, active only while running.

## Extension sidebar

A `ShellCard` in `src/webview/components/` rendered by the transcript for `role: 'shell'`, using shadcn
(`Button` for cancel, `cn` for classes). Monospace output in a clamped, scrollable region; status as text plus
colour, never colour alone; long lines scroll inside the card rather than widening the 300-500px pane. The
composer gets the same `!` cue. The change goes through the impeccable detector, in Operate mode.

## Invariants kept

- `messages.ts` stays types-only; the new messages carry `SessionId`.
- Nothing in the TUI, `client-core`, or `daemon` imports `vscode`.
- Over a daemon, a client posts messages; it never executes the command or reads host files.
- A host never writes a session it does not own: foreign sessions are refused, and `markForeign` already
  turns the appends into no-ops.
- Errors are state; no unhandled rejection from the runner.
- Transcript patches fan out only to visible sessions, so a hidden session's command still runs and is stored,
  and a client sees it when it shows the session.

## Out of scope

- Interactive programs (stdin, TTY, `vim`, `top`). No stdin is attached; they fail or exit.
- Per-command permission rules, a default-shell setting, up-arrow recall of `!` lines, separate stdout and
  stderr streams, more than one concurrent command per session.

## Tests

- **Unit (mocha):** `parseShellCommand`; alias resolve and validation (defaults, override, `null`, malformed);
  `shell-runner` with real short commands (`node -e`): exit code, stderr, tail truncation with continued
  draining, timeout (injected short limit), cancel, dispose-kills; `shell-context` block building and its cap.
- **Session:** `runShell` appends then replaces and persists to the JSONL; a command during a running turn
  leaves status alone; a second concurrent command is refused.
- **Router:** unknown session, foreign session, and `run-shell` being unreachable from the self-control path.
- **DOM:** `!ls` in the real `StoreProvider` posts `run-shell` and not `send`; a `session-patch` carrying a
  shell item renders the card; Cancel posts `cancel-shell`. Assertions on strings and counts, never DOM nodes.
- **TUI (bun test):** composer routing and the card view model; no renderable handed to an assertion.
- **Daemon:** a command started by one attached client appears on a second, and survives the first
  disconnecting.

## Open points for the plan

- Confirm `bind-surface` does not intercept `run-shell`.
- Windows tree-kill details and Git Bash discovery order.
- Whether `replace` every 250ms is acceptable for the JSONL writer, or the store should coalesce replaces of
  one item id before flush.
