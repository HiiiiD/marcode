# `!` shell commands in the composer

A composer line starting with `!` runs as a shell command in the session's working directory, in the TUI and
in the extension sidebar. It never reaches the model.

## Decisions

| Question | Decision |
|---|---|
| Where it runs | The host (daemon or in-process), in the session's `cwd`. A client never spawns it |
| Persistence | None. Output is not written to the JSONL, not in `SessionState`, not fed to the model. A reload or reconnect drops it |
| Who sees it | Only the connection that asked. Answered through the router's `emit`, not the `PostBus` |
| Permissions | None. The user typed it; it sits outside the permission modes, same as in Claude Code |
| Agent access | None. Accepted from client connections only; never from `marcode__*` or any provider path |
| Foreign sessions | Refused, like every mutator |
| Streaming | Yes, with cancel. Timeout and output cap |

## Wire

`src/protocol/messages.ts`, types only. Every message carries `SessionId`, plus a client-chosen `runId` so
one client can run several.

```
WebviewToHost:
  { t: 'run-shell';    id: SessionId; runId: number; command: string }
  { t: 'cancel-shell'; id: SessionId; runId: number }

HostToWebview:
  { t: 'shell-chunk';  id: SessionId; runId: number; stream: 'stdout' | 'stderr'; text: string }
  { t: 'shell-done';   id: SessionId; runId: number; exitCode: number | null; signal?: string;
                       truncated?: boolean; timedOut?: boolean; error?: string }
```

Both host messages are replies, so they go out through the router's `emit` to the asking connection.
`wantsFor` needs no change: `REVIEW_WANTS`, `FLEET_WANTS` and `HISTORY_WANTS` gate `bus.post`, and nothing here is
posted there. `run-shell` and `cancel-shell` must be added to `KNOWN_MESSAGE_TAGS` in `message-router.ts`, the
allow-list of tags the router accepts; an unlisted tag is dropped.

## Host

New `src/host/shell-runner.ts`, no `vscode` import. Pure Node `child_process.spawn`.

- **Shell:** `bash -c` by default on every platform. On Windows it resolves Git Bash (`bash.exe` on PATH, then
  the Git for Windows install); if none is found, the run ends with an error that names the `shell.aliases`
  setting. `windowsHide: true`.
- **Aliases:** if the command's first token, followed by whitespace, matches an alias, the rest of the line is
  run through that alias instead of bash. Resolution is host-side: the client sends the raw text after `!`.
  An alias shadows a same-named program, so `!pwsh --version` runs PowerShell, not a `pwsh` found by bash;
  a user who wants the program wraps it (`!bash -c 'pwsh --version'`).
- **cwd:** the session's current `cwd`, read when the command starts, so a worktree move is honoured.
- **Environment:** `process.env` as the host has it. No secrets are added.
- **Limits:** 120s wall timeout, 256 KiB of output across both streams. At the cap the process is killed and
  `shell-done` carries `truncated: true`; on timeout `timedOut: true`.
- **Chunking:** stdout/stderr coalesced to one frame per 50ms so a noisy command cannot flood the socket or
  trip the slow-client drop in `daemon/connection.ts`.
- **Cancel:** `cancel-shell` kills the process tree (`taskkill /T /F` on Windows, process group on POSIX).
- **Lifecycle:** runs are owned by the router (one per connection). `MessageRouter.dispose` kills everything it
  started, so a dropped client leaves no orphan. A run whose session is deleted or goes foreign is killed.
- **Errors are state:** spawn failure becomes `shell-done { error }`. Nothing rejects across the wire.
- **Redaction:** no. The output goes only to the user who ran the command and is never stored.

Router case: resolve the session (`manager.get`), refuse if missing or `isForeign`, then
`runner.start(...)`. The handler is single-use, so it stays inline in the router with the process logic in
`shell-runner.ts`.

## Config

`shell.aliases` in `~/.marcode/config.json`, read by `createHost` like every host setting (`docs/config.md`,
reload to apply; stored as `shellAliases` per the `codexPath` flat-key precedent in `host-config.ts`).

```json
{ "shell": { "aliases": { "pwsh": { "command": "pwsh", "args": ["-NoProfile", "-Command"] } } } }
```

- The line after the alias is appended as the final argument. No shell string-building, so no quoting layer.
- Built-in defaults: `pwsh` (`pwsh -NoProfile -Command`) and `powershell` (`powershell.exe -NoProfile
  -Command`). A user entry with the same name replaces the default; `null` removes it.
- Validation drops malformed entries (non-string `command`, non-string-array `args`, a name with whitespace or
  starting with `-`) and keeps the rest, as the other list settings do.
- An alias whose executable cannot be spawned ends the run with `shell-done { error }`.
- Aliases are host config, never client input: a client cannot define one, so it cannot choose an arbitrary
  executable beyond what the user typed after `!`, which is already arbitrary by design.

## Client state

`src/client-core/`, no React or DOM. A small reducer slice, `shellRuns: Record<SessionId, ShellRun[]>`:

```
ShellRun { runId; command; output: string; status: 'running' | 'done'; exitCode?; truncated?; timedOut?; error? }
```

- Local actions `shell-started` (adds the run before the host answers) and a per-session cap of the last
  10 runs.
- `shell-chunk` / `shell-done` fold into the run. Chunks for an unknown `runId` are dropped (the run was
  dismissed or the state reset).
- Cleared on `hydrate`: a reload or reconnect is a fresh start, which is the "not saved" decision.
- `runId` comes from a client-local counter. It is only unique within one connection, which is all the
  host's per-connection runner needs.

## Composer behaviour

Shared parse in `client-core`: `parseShellCommand(text)` returns the command when the trimmed text starts with
`!` followed by non-whitespace, else `undefined`. A lone `!` and `!!` are sent as ordinary prompts.

- **Submit:** post `run-shell`, clear the box and draft, add the run locally. Nothing is sent to the model, no
  `queued:` line, and it works while the session is `running` (the shell is independent of the turn).
- **Draft:** the `!` text is a normal draft until submit; it persists like any draft.
- **Mode hint:** while the text starts with `!`, the placeholder and frame tone change to a shell cue
  (`Shell — Enter run, Esc cancel`). Cosmetic only.
- **Mentions and slash popups:** closed in shell mode. `@` and `/` mean paths and flags here.
- **History:** shell commands are not added to prompt history (they are not in the transcript, which is
  the history's source). Up-arrow recall of `!` lines is out of scope.

## TUI

Ephemeral blocks render **below the transcript, above the composer**, in the pane. They are not transcript
items, so they do not scroll with history and vanish on dismiss.

- A block shows `$ command`, the output (clamped to the last 12 lines while running; full after with
  scroll), and a footer: `running…` / `exit 0` / `exit 1` / `cancelled` / `timed out` / `truncated`.
- Built on the existing `panel.tsx` frame and `tool-blocks.tsx` command/output rendering. ANSI is stripped.
- Esc on a running block sends `cancel-shell`; Esc on a finished block dismisses it. Key routing goes through
  `keymap.ts`, as every other binding does.
- The animation uses the shared `use-ticker.ts` only while a run is active.

## Extension sidebar

A `ShellRunCard` in `src/webview/components/`, above the composer in the pane, using the same slice via the
webview reducer. shadcn only: `Button` for cancel/dismiss, `cn` for classes. Monospace output in a clamped,
scrollable region, status as text plus colour, never colour alone. The composer gets the same `!` mode cue.
Verified with the impeccable detector and `Operate` mode in mind: 300-500px width, long lines wrap or scroll
horizontally inside the card rather than widening the pane.

The webview reducer and the TUI store share the `client-core` slice, so the logic is written once.

## Invariants kept

- `messages.ts` stays types-only; the new messages carry `SessionId`.
- Nothing in the TUI, `client-core`, or `daemon` imports `vscode`.
- Over a daemon, the client posts messages; it never executes the command or reads host files.
- A host never acts on a session it does not own.
- Errors are state; no unhandled rejection from the runner.
- Not persisted, so no JSONL, `updatedAt`, digest, or memory involvement.

## Out of scope

- Feeding output to the model, or saving it to the transcript (explicit decision; revisit if wanted: it
  would add a transcript item kind and a pending-context queue, and those are the pieces that were left out).
- Interactive programs (stdin, TTY, `vim`, `top`). No stdin is attached; they fail or exit.
- Per-command permission rules, history recall, a default-shell setting (aliases cover choosing a shell per run).

## Tests

- **Unit (mocha):** `parseShellCommand` cases; the reducer slice (chunk folding, cap of 10, unknown `runId`,
  clear on `hydrate`); `shell-runner` with real short commands (`node -e`): exit code, stderr, truncation,
  timeout (injected short limit), cancel, and dispose-kills.
- **Router:** unknown session, foreign session, and a second connection never receiving the first's chunks.
- **DOM:** `!ls` in the real `StoreProvider` posts `run-shell` and not `send`; `shell-chunk` and `shell-done`
  from `sendFromHost` render the card; Esc/Cancel posts `cancel-shell`. Assertions on strings and counts,
  never DOM nodes.
- **TUI (bun test):** composer routing and block view model; no renderable handed to an assertion.
- **Daemon:** an attached client's run streams over the socket and stops when the socket closes.

## Open points for the plan

- Confirm `bind-surface` does not intercept `run-shell`.
- Windows tree-kill details and Git Bash discovery order.
