# TUI roadmap after v1

Written 2026-10-01 (committed on `feat/tui-termcn`, which contains `feat/tui-features`), so the next session does not depend on chat history. Each item
below is its own cycle: spec in `docs/superpowers/specs/`, plan in `docs/superpowers/plans/`, then execution.

## Done

- **v1** (`feat/tui`): single pane, roster, transcript, composer, approvals and questions, new session,
  model/effort/mode switching, foreign-session read-only label.
- **B. Composer and roster** (`feat/tui-features`): `@` file mentions, path attachments (paste and `/attach`),
  roster pin, filter, hide and delete. Spec `2026-10-01-tui-composer-roster-design.md`, plan
  `2026-10-01-tui-composer-roster.md`.

## In progress (branch `feat/tui-termcn`, stacked on `feat/tui-features`)

- **termcn adoption.** The v1 spec said "OpenTUI with termcn-style copy-paste components" but v1 and B were
  hand-written. Done by Marcode session `claude-qaes5zqy`, installed through the shadcn CLI and vendored under
  `src/tui/ui/termcn/`. Landed: marcode theme, delete confirm, new-session dialog, attachment chips, roster,
  transcript rows on termcn chat-message and tool-call. Spec `2026-10-01-tui-termcn-adoption-design.md`.
  Docs for the vendored components are in `docs/`; check `git log feat/tui-features..feat/tui-termcn`.
- **Model, effort and mode dialogs** (`feat/tui-model-effort-dialogs`, off `feat/tui-termcn`): Ctrl+P, Ctrl+E,
  Shift+Tab and `/model` `/effort` `/mode` open webview-style dialogs; the cycle keys are gone. Mode rows are shared with the
  webview through `src/shared/permission-modes.ts`.
- **Tool cards at webview parity.** Spec `2026-10-01-tui-tool-cards-design.md` and its plan are written; check
  whether execution has started before picking it up.

Do both before C: split panes reshape the same components.

## Next, in the order the user approved

1. **C. Multi-session.** Split panes over the visible sessions with a persisted per-host layout; mouse support;
   handoff seeds and forking. Includes the `marcode__spawn_session` fix: it adds spawned sessions to the visible
   set, which breaks the TUI's "exactly one visible session" rule, so panes need a defined meaning of "visible".
2. **D. Awareness.** Context dialog and a context share in the status line; usage strip; worktree and relocation
   cards (currently a read-only one-line notice).
3. **E. Review and history.** Fleet-diff review and history surfaces. Biggest items; need their own surface design.
4. **F. Platform.** In-TUI login by suspending the renderer; recall and memory (off under Bun because
   `node:sqlite` is unavailable there, so it needs a replacement).

## Deferred hardening (group A)

- A failed `create-session` for `marcode "prompt"` drops the prompt silently.
- Handler errors go to `console.error`, invisible under the OpenTUI console overlay.
- `codexLoginCommand` uses `printenv` (not on cmd.exe) and an unquoted `binPath`.
- Dismissible notices.
- A few tests use fixed sleeps.
- CI runs neither `yarn check-types:tui` nor `bun test`.
- Not planned: roster rename (`r` stays an unbound action), the empty-state prompt picker, clipboard-image attach.

## Deferred minors from B's final review

- An out-of-order `file-search-result` replaces a newer one and closes the popup until the next keystroke.
- Recalling a prompt that ends in a mention opens the popup and takes Up and Enter.
- Picking a mention mid-text moves the cursor to the end (`pick()` returns a caret nothing uses).
- The popup is not re-evaluated on arrow-key caret movement.
- Attachment rejections show in the chip row, not the notice line, and cannot be dismissed
  (`local-dismiss-rejection` is never dispatched).
- GNOME-style `'it'\''s.txt'` quoting is not parsed.
- Esc dismissal is tied to a column position rather than "until the next `@` is typed"; searches keep posting while dismissed.
- The delete confirm accepted modified `y`/`n`, blocked Ctrl+C, and rendered above the status line, not in the bottom slot.
- A pending file ref is lost if the Composer remounts (a permission or question slot swap).
- `statSync` on a UNC path can stall the UI thread during a paste.
- Predates B: the Composer is not keyed by `sessionId`, and its draft seed skips an empty draft.

## Not verified in a real terminal

- Whether dropping a file onto the window fires paste (Windows Terminal, plus one macOS or Linux terminal).
  `/attach` is the fallback.
- From v1: signals, the markdown first-frame flash, double key handling in the scrollbox, and the compiled
  binary's tree-sitter assets. The manual smoke checklist is in `docs/tui.md`.

## Environment notes

- `yarn test:unit` intermittently fails on this machine with `listen EACCES` on loopback ports in the
  `SelfControlMcpServer` tests (and occasionally an `ENOTEMPTY` on a temp dir); re-run before treating it as real.
- Write files that contain backslashes with the Write or Edit tools, not shell heredocs: the shell halves them.
- A lone Esc reaches OpenTUI on a timer; tests wait about 100ms inside `act` (see `settleEscape`).
