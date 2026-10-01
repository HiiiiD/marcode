# Marcode TUI

A terminal client for the same sessions the VS Code panel runs. It boots its own host in-process
(`createHost`), uses the same `~/.marcode/workspaces/<slug>` directory, and renders with OpenTUI.
Sessions, transcripts and `config.json` are shared with the extension.

## Install and run

```
yarn build:tui        # dist/tui/tui.js (+ its assets), run with: bun dist/tui/tui.js
yarn build:tui:bin    # bin/marcode.exe (bin/marcode elsewhere): standalone, Bun runtime embedded
```

| Command | Effect |
|---|---|
| `marcode` | open the TUI, resuming the last session |
| `marcode "<prompt>"` | start a session with that prompt |
| `marcode --new` | start a fresh session instead of resuming |
| `marcode login <provider>` | hand the terminal to the provider's sign-in flow (`claude`, `codex`) |
| `marcode config` | print the path of `config.json` and open it in `$EDITOR` |
| `marcode migrate <old-dir>` | copy an old VS Code storage folder into the workspace directory |
| `marcode -- <prompt...>` | a prompt that starts with a subcommand word |

`MARCODE_HOME` overrides `~/.marcode`. Exit codes: 0 ok, 2 usage error, 1 other failure.

## Keys

| Key | Where | Action |
|---|---|---|
| Enter | composer | send |
| Ctrl+J, Alt+Enter | composer | newline (terminals deliver Ctrl+J as `linefeed`) |
| Up | composer, cursor at the start | walk prompt history |
| Esc, Ctrl+C | a turn is running or awaiting approval | interrupt |
| Ctrl+C twice | idle | quit |
| Tab | anywhere but approval/question | cycle composer, transcript, roster |
| Ctrl+B | anywhere | toggle the roster |
| Ctrl+N | anywhere | new session dialog |
| Ctrl+P / Ctrl+E | anywhere | cycle model / effort |
| Shift+Tab | anywhere | cycle permission mode (never into `bypass`) |
| Ctrl+R | anywhere | re-check providers |
| j / k, Enter | transcript | next / previous item, expand or collapse |
| PgUp / PgDn, End | transcript | scroll, re-pin to the bottom |
| j / k, Enter, x | roster | move, focus, hide the session from the panes |
| y / n, Enter | approval | allow / deny (n opens a reason; Enter confirms, Esc leaves the reason) |
| Up / Down, Space, Enter | question | move, toggle, submit; "Other" takes free text; secret questions are masked |

## Sharing sessions with VS Code

Each session is owned by one host through a lease (`sessions/<id>.lock`). A session leased by
another live host, VS Code or another terminal, shows up read-only with a `host·pid` label such as
`vscode·1234`; its transcript follows the owner. When the owner lets go (closes or hides it) the
composer returns. Changes to `config.json` are not applied live: the TUI shows a "restart to apply"
notice, then restart it. See `config.md`.

## Runtime and limits

- OpenTUI needs Bun >= 1.3 (or Node >= 26.4 with `--experimental-ffi`). The extension stays on Node 22;
  the TUI is a separate Bun/ESM build, and `bin/marcode` embeds Bun, the native library and the
  tree-sitter assets.
- Memory and recall are off in the TUI: `node:sqlite` does not exist under Bun (see
  `superpowers/notes/2026-10-01-bun-host-spike.md`). Sessions created from the TUI are not digested.
- `dist/tui/tui.js` references its assets by absolute path; run it where it was built.
- Shift+Enter is not distinguished from Enter by most terminals; use Ctrl+J or Alt+Enter.
- Roster rename and "remember last effort/mode" in the new-session dialog are not implemented.

## Manual smoke checklist

Run in Windows Terminal and in one macOS or Linux terminal.

- [ ] Resize below 100 columns and back: the roster becomes an overlay, then a column again.
- [ ] Paste a multi-line block into the composer: it arrives intact, no send, no stray keys.
- [ ] Ctrl+J and Alt+Enter insert a newline; note whether Shift+Enter sends or inserts one.
- [ ] Colours stay legible on a light terminal theme.
- [ ] Ctrl+C while running interrupts; Ctrl+C twice while idle quits and the prompt, cursor and main screen are restored.
- [ ] `kill -TERM` and closing the tab (SIGHUP) shut the host down; `sessions/<id>.lock` is gone afterwards.
- [ ] An uncaught error (force one) restores the terminal.
- [ ] Run a session in VS Code on the same folder: it appears as `vscode·<pid>`, read-only; release it in VS Code and the composer returns.
- [ ] Esc interrupts a running turn, also while an approval is pending.
- [ ] An approval answered with `y`, and another with `n` plus a reason.
- [ ] A question with options, and a free-text or secret question (masked).
- [ ] `marcode login claude` hands the terminal over and returns cleanly.
- [ ] `marcode config` opens `$EDITOR`.
- [ ] Edit `config.json` while the TUI runs: the "restart to apply" notice appears.
- [ ] Streaming markdown: no first-frame flash of raw text.
- [ ] Scrollbox with arrow keys: a key is not handled twice (no double scroll).
- [ ] Long transcript: k or PgUp at the top loads earlier items.
- [ ] Close the focused session via roster `x`: focus falls back to a neighbour or the empty state.
- [ ] The compiled `bin/marcode` renders markdown with highlighted code blocks (tree-sitter assets load from the embedded filesystem).
