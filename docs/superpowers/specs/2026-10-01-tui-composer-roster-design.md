# TUI composer and roster (round 2, sub-project B)

Branch: `feat/tui-features`, stacked on `feat/tui`.

## Where this sits

The TUI v1 left out a long feature list. The user chose everything except hardening, in this order,
each as its own spec, plan and execution cycle:

1. **B. Composer and roster** (this spec)
2. C. Multi-session: split panes with a persisted layout, mouse, handoff and fork. The
   `marcode__spawn_session` visible-set fix is pulled into C, because panes need a defined meaning of "visible".
3. D. Awareness: context share, usage strip, worktree and relocation cards
4. E. Review and history surfaces
5. F. Platform: in-TUI login, recall/memory under Bun

The rest of the hardening list (dropped prompt on a failed create, invisible handler errors,
`codexLoginCommand`, dismissible notices, CI gates, fixed test sleeps) is deferred.

## Goal

Make the single-session TUI comfortable to use every day: mention files, attach files, and manage the
roster, without leaving the keyboard.

In scope: `@` file mentions, path-based attachments (including paste of a path), roster pin,
filter, close and delete.

Out of scope: clipboard image reads, roster rename (`r` stays an unbound action), the empty-state prompt
picker, session mentions in the TUI, mouse support.

## Existing support (no host or protocol changes)

- `file-search` / `file-search-result`, `FileRef`, and `send.fileRefs` exist and are handled by
  `MessageRouter`.
- `attach-drop` (URIs), `attach-remove`, `session-attachments` and `attachments-rejected` exist.
  `createHost` constructs `AttachmentStore` and `boot.ts` passes it to the router.
- `set-pinned`, `close-session` and `delete-session` exist.

## Design

### 1. Share the mention logic

`src/webview/lib/mention-menu.ts`, `file-mentions.ts` and `session-mentions.ts` import only protocol
types, so they move to `src/client-core/mentions/` with their unit tests (`git mv`). The webview imports
change; behaviour does not. This keeps one implementation of query detection, filtering, token
building and pruning for both clients. `client-core` stays free of React and DOM.

### 2. `@` mention popup (TUI)

- `src/tui/ui/mention-popup.tsx` renders a result list above the composer.
- `src/tui/ui/use-mention-popup.ts` watches text and cursor. `mentionQuery` finds an `@token` ending at
  the cursor. A debounced (~150ms) `file-search` carries the session id; a `file-search-result` whose
  `query` does not match the current one is dropped.
- While the popup is open it owns Up, Down, Tab, Enter and Esc. Enter inserts instead of sending. Esc
  dismisses until the next `@` is typed.
- Selecting inserts the token via `spliceMention` and records a pending `FileRef`.
- On send, pending refs are filtered with `pruneMentions` to tokens still in the text, and go out as
  `send.fileRefs`.

### 3. Path attachments

- `src/client-core/path-paste.ts` (pure): parses pasted text into candidate paths. Accepts quoted,
  backslash-escaped and `file://` forms, Windows and POSIX absolute paths, and multiple paths separated
  by newlines or spaces outside quotes. Returns normalised file URIs.
- The composer's `onPaste` hands the text to the parser. If every candidate exists on disk (checked
  in the TUI layer with `fs`, not in client-core), it posts `attach-drop` with the URIs and swallows
  the paste. Otherwise the text is inserted normally. A pasted existing path therefore attaches, which
  is how most terminals deliver a drag and drop.
- `/attach <path>` is the explicit form. It goes through the same parser and posts `attach-drop`.
- `session-attachments` drives a chip row above the composer (name and size). `Ctrl+X` while the composer
  is focused with chips present removes the last chip via `attach-remove`.
- `attachments-rejected` reasons are shown through the existing notice line.

### 4. Roster actions

All in the roster zone (keymap):

| Key | Action |
|---|---|
| `p` | Toggle pin: `set-pinned`. Pinned rows sort first and show `★`. |
| `/` | Start a filter on the title. Typing narrows, `Esc` clears. |
| `x` | Hide (unchanged): `close-session`. |
| `D` | Delete: opens a one-line confirm `Delete "<title>"? y/n` in the bottom slot, `y` posts `delete-session`. |

A foreign-owned session refuses delete in the UI: the confirm does not open, and the notice line says
why. The host also refuses; the UI check is only a courtesy.

`rosterRows` (pure, `src/tui/view/roster-rows.ts`) takes pinned state and the filter text and returns
rows, so it unit-tests on mocha.

## Invariants kept

Nothing under `src/tui/` or `src/client-core/` imports `vscode`; `client-core` has no React or DOM;
`src/protocol/messages.ts` stays types-only; every session-addressed message carries a `SessionId`;
errors are state: failures surface as notices, never as thrown exceptions; the TUI never writes a
session it does not own.

## Testing

- **mocha (`src/test/unit`)**: moved mention tests; `rosterRows` pin/filter/order; `path-paste` parsing
  (quoted, escaped, `file://`, Windows drive paths, relative and empty input).
- **bun (`src/test/tui`)**: popup flow (open on `@`, stale result ignored, Enter inserts and does not
  send, Esc dismisses); attach by paste and by `/attach`; chip row and removal; rejected-attachment
  notice; roster pin, filter, delete confirm and foreign refusal. Real `HostToWebview` messages through
  the harness, frame strings and counts only, never a renderable in an assertion.
- Gates: `yarn test:tui`, `yarn test:unit`, `yarn test:dom` (webview imports moved), `yarn lint`,
  `yarn check-types`, `yarn check-types:tui`.
- `docs/tui.md` gains the new keys and the paste behaviour, and the manual smoke checklist gains the
  real-terminal items below.

## Risks and open items

- **Paste events are unverified in a real terminal.** OpenTUI exposes `onPaste` with a `PasteEvent`, but
  it has not been seen firing for a terminal drop on Windows Terminal. If it does not, `/attach` remains
  the working path and the plan records the finding.
- A path that happens to exist but was meant as text will attach. The `@` mention or typing the path
  covers that case.
- Pin and filter hinge on `SessionState.pinned` being set by the host after `set-pinned`. The plan's
  first task confirms this with a harness test before building on it.
