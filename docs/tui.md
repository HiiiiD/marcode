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
| Up | composer, box empty or cursor at the very start | walk prompt history (keeps walking while the cursor is on the first line) |
| Esc | your own session's turn is running or awaiting approval | interrupt |
| Ctrl+C | your own session's turn is running or awaiting approval | interrupt; a second Ctrl+C within 2 s quits even if the turn has not stopped |
| Ctrl+C twice | idle, or a session owned by another host | quit |
| Tab | anywhere but approval/question | cycle composer, transcript, roster |
| Ctrl+B | anywhere | toggle the roster |
| Ctrl+N | anywhere | new session dialog |
| Up / Down or k / j, Enter, Esc | new session dialog | move; Enter picks the provider, then the model (skipped when it has one); Esc cancels. Starts on the focused session's provider and model, and the new session inherits its effort and mode |
| c | new session dialog | create now as a copy of the focused session's provider and model |
| Ctrl+P / Ctrl+E | your own session | open the model dialog (type to search, favorites first) / the permission-mode dialog on its effort row (Left/Right steps the level live) |
| Shift+Tab | your own session | open the permission-mode dialog (`bypass` is greyed once the session has started) |
| Ctrl+T | your own session | open the context dialog (window, slices, memory files; `r` retries a failed read). The status line shows `ctx N%`, red from 80%, and clicking it does the same |
| `/model`, `/effort`, `/mode`, `/context`, `/layout` | composer | the same dialogs, typed and sent with Enter |
| Ctrl+R | anywhere | re-check providers |
| Ctrl+G | anywhere | refresh plan usage; clicking the usage strip does the same, and a spinner shows until the round is done |
| Ctrl+Y | your own session | move the session to the offered worktree (the newest open offer in the focused pane) |
| Ctrl+L | your own session | stay in the current directory, or cancel a move queued behind a running turn |
| Ctrl+W, then h j k l or arrows | anywhere | focus the pane in that direction |
| Ctrl+W, then `|` / `-` | anywhere | split right / below: opens the new-session dialog, and the session lands in the new pane |
| Ctrl+W, then m / = | anywhere | maximize the focused pane (view only) / even out every split |
| Ctrl+W, then H J K L | anywhere | move the focused pane's divider by 5% (one layout write) |
| Ctrl+W, then x | anywhere | hide the focused pane's session (it stays in the roster) |
| Ctrl+W, then g | anywhere | open the layout dialog: grid rows x columns, built-in and saved presets, `s` saves the current shape, `d` deletes a saved one. Applying a shape with fewer slots than open sessions asks first; hidden sessions stay in the roster |
| f | transcript | fork the selected message into a new session beside this one (not for a session owned by another host) |
| Shift+H | roster | hand off from the row: opens the new-session dialog with the handoff on |
| h | new-session dialog | toggle "Hand off from <focused session>"; with it on, a prompt line follows the provider and model picks |
| j / k, Enter | transcript | next / previous item (a message or a tool/subagent card), expand or collapse a card |
| PgUp / PgDn, End | transcript | scroll, re-pin to the bottom |
| j / k, Enter, x | roster | move, focus, hide the session from the panes |
| p | roster | pin or unpin the session (pinned sort first, shown with a star) |
| / | roster | filter by title; Enter keeps the filter, Esc clears it |
| Shift+D, then y / n | roster | delete the session after confirming; refused for a session owned by another host |
| @ then Up / Down, Tab or Enter, Esc | composer | file mention popup: a pick inserts `@path`, and the file's content travels with the message |
| / at the start of the box, then Up / Down, Tab or Enter, Esc | composer | skill and slash-command menu for the session's provider: a pick inserts the command. Typed built-ins (`/model`, `/layout`, ...) still work |
| Ctrl+X | composer | remove the last attachment |
| Ctrl+V | composer | attach an image from the clipboard |
| y / n, Enter | approval | allow / deny (n opens a reason; Enter confirms, Esc leaves the reason) |
| Up / Down, Space, Enter | question | move, toggle, submit; "Other" takes free text; secret questions are masked |

## Panes and mouse

Every session with a pane is visible: the layout's leaves are the visible set, and only visible sessions stream.
Roster Enter focuses a session that has a pane, or places it (first free slot, else beside the focused pane).
A session an agent starts with `marcode__spawn_session` gets a pane the same way, without taking focus. The
layout is saved per host (`layout.tui.json`), so a restart brings the same panes back.

Only the focused pane takes keys; a pane with an approval or question shows it but waits until you focus it.
A pane under 40 x 8 cells collapses to one line, and when the tree does not fit the terminal the focused pane is
maximized (view only; saved sizes are untouched). A `▪` in the roster marks a session that has a pane.

Mouse: click a pane, a roster row or a tool card header; drag the divider between panes to resize (one layout
write on release; dragging out of the window cancels); click ✕ in a title to hide the pane; the wheel scrolls
the pane under the pointer. Every mouse action has a keyboard equivalent.

## Attachments

Paste an absolute file path (most terminals paste the path when you drop a file onto the window) or send
`/attach <absolute path>`: the file becomes an attachment chip above the box. Pasted text that is anything
else, including prose that merely contains a path, a path that does not exist, or a directory, is inserted
as normal text.

Ctrl+V in the composer attaches an image from the clipboard (also tried when a terminal pastes nothing). It shells out to
PowerShell on Windows, `osascript` on macOS, and `wl-paste` or `xclip` on Linux; a missing tool is named in a notice.

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
- Memory and recall run in the TUI on `bun:sqlite` through `src/memory/sqlite-driver.ts`, over the same
  `memory.sqlite` as the VS Code host. Not verified: macOS, where `bun:sqlite` uses the system SQLite and
  may lack FTS5 (the store then stays off and a warning says so).
- `dist/tui/tui.js` references its assets by absolute path; run it where it was built.
- Shift+Enter is not distinguished from Enter by most terminals; use Ctrl+J or Alt+Enter.
- Roster rename and the empty-state prompt picker are not implemented. See [Not in the TUI yet](#not-in-the-tui-yet) for the full comparison with the VS Code panel.

## Appearance

Panels, diffs and code are tinted from your terminal's own colors: right after the first paint the TUI
asks the terminal for its background, foreground and ANSI palette (OSC) and derives the surfaces from
them, so light and dark terminals both work. Startup never waits for the reply. If the terminal does
not answer within 1.5 s, or the colors are unusable (foreground nearly equal to background), the TUI
stays on plain named colors and bordered cards. Diffs render with line numbers and syntax highlighting; a card at least
120 columns wide shows them side by side. Diffs over 120 lines, or patches the renderer cannot parse,
show as clamped +/- lines.

## Vendored components

Some TUI visuals come from [termcn](https://github.com/shadcn-labs/termcn) (MIT), installed with the shadcn
CLI into `src/tui/ui/termcn/`, which has its own `components.json`, `package.json` and `tsconfig.json`:

```
yes n | npx shadcn@latest add @termcn/opentui/<name> --yes --cwd src/tui/ui/termcn
```

Local edits to the generated files are listed in `src/tui/ui/termcn/PATCHES.md` and must be reapplied after
`--overwrite`. Theme tokens come from `src/tui/ui/tui-theme.tsx`, which maps our terminal colour names into
termcn's theme. Always render a freshly installed item and look for stacked rows: registry code often omits
`flexDirection="row"`, and OpenTUI boxes default to a column.

## Usage strip and worktree offers

The roster ends in a usage strip: one name line per provider that reports plan windows, then a line per window
(`5h ████░░ 62% 1h02m`). Only percentages are shown, never token counts. It is absent while nothing reports, windows
whose reset has passed drop out on their own, and on a narrow roster the countdown goes first, then the label, then the
bar. A stale reading is replaced by `Ctrl+G` or a click on the strip.

A worktree offer in the transcript is a card. Pending offers show `^Y move  ^L stay`; a move answered during a running
turn shows as queued with `^L cancel`; answered offers collapse to one muted line. Only the newest open offer in the
focused pane takes the keys, older open ones read "superseded", an unfocused pane says to focus it, and a session
owned by another host shows the offer without keys.

## Not in the TUI yet

The TUI renders the same host state as the VS Code panel, but not every surface has a terminal version. Anything
below works in VS Code only; sessions, transcripts and settings are shared, so nothing is lost by switching.

| Area | VS Code panel | TUI |
|---|---|---|
| Fleet diff review tab (**Marcode: Review fleet changes**) | yes | no |
| Fleet view, subagent drill-in (**Marcode: Open fleet view**) | yes, a focused list per subagent run | no: a subagent is a collapsible card in the transcript; its inner transcript is not browsable |
| Session history tab (**Marcode: Open history**): sort, filter, digests | yes | no: the roster has pin and title filter only |
| Memory reindex command | yes | no (recall and priming do run) |
| Roster rename | yes | no |
| Bring-back dialog (delete a worktree, check its branch out in the main tree) | yes | no: a worktree offer can be moved to or declined, not brought back |
| Stale-trees notice | yes | no |
| Editor-context chip (active file and selection sent with a prompt) | yes | no: there is no editor; use `@path` |
| CLAUDE.md / AGENTS.md drift nudge card | yes | no |
| Prompt-cache warm/cold timer badge | yes | no |
| Empty-state prompt picker | yes | no |
| Drag a pane to rearrange | yes | no: move panes with Ctrl+W chords |
| Account-setup wizard and one-click reauth | yes | `marcode login <provider>` for Claude and Codex; edit `config.json` for the rest |
| Settings UI | VS Code settings and `config.json` | `config.json` only (`marcode config`) |

Update this table in the same change that closes a row.
