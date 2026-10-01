# TUI tool cards at webview parity

Branch: `feat/tui-termcn` (stacked on the termcn adoption work).

## Background

The TUI renders a tool call as one gray line (`▸ ✗ Read path`) and flattens a subagent's children into
separate rows with a 2-space indent. The VS Code panel renders them as bordered cards with a per-tool glyph,
a bold verb, a muted path, a `failed` pill, and a body with the input blocks and a Result or Error section;
a subagent is a card that contains its child cards. The goal is the same experience in the terminal.

Webview sources of truth: `src/webview/components/tool-card.tsx`, `tool-body.tsx`, `subagent-card.tsx`,
`subagent-window.ts`; shared description layer: `src/client-core/tool-render.ts` (`describeTool`,
`describeInput`, `describeOutput`, `ToolGlyph`, `ToolBlock`, `clampLines`).

## Goal

Tool calls and subagents in the TUI transcript look and behave like the webview's cards, using the same
shared description layer. Nothing about the protocol, the host or the webview behaviour changes.

Out of scope: a duration column (the protocol carries only `ts`, no start or end), permission and question
cards (they stay one line; the bottom-slot approval prompt is unchanged), the webview's "Open full
transcript" button (a Fleet-tab concept), expanding a subagent's child cards one by one.

## Design

### 1. Shared code

`src/webview/components/subagent-window.ts` and its unit test `src/test/unit/subagent-window.test.ts` move to
`src/client-core/` with `git mv` (it imports only protocol types, the same reason the mention helpers moved).
Importers change path only: `src/fleet/subagent-list.tsx`, `src/webview/components/subagent-card.tsx`,
`src/webview/components/subagent-transcript.tsx`. `src/fleet/filter-subagents.ts` only mentions the file in a comment.

### 2. Row model

`transcriptRows` (`src/tui/view/transcript-rows.ts`) stops flattening a tool item's children. Each top-level
tool item becomes one `kind: 'tool'` row that carries the whole `ToolItem`. The cursor, `j`/`k`, `Enter`,
paging and `scrollChildIntoView` operate on these top-level rows, unchanged in behaviour. Children of a
subagent are drawn inside its card, not as selectable rows.

### 3. Components (all under `src/tui/ui/transcript/`, hand-written)

- `collapsible.tsx`: controlled shell. Props `open`, `selected`, `header` (node), `children` (body). A bordered
  box (`single`, muted; primary when `selected`); the header row; when `open`, a divider line and the body.
  No keys, no state, no timers.
- `tool-card.tsx`: a `Collapsible` whose header is the per-tool glyph, a muted server chip for MCP tools, a bold
  verb, the muted primary (single line, clipped), then right-aligned a `failed` pill on error and the chevron
  `▸`/`▾`. Success shows no mark; running shows a spinner; error shows `✗`. Body: `describeInput` blocks, then a
  muted `Result` (or `Error`) label and the `describeOutput` blocks, and `Running…` while running.
  An `interactive`-free variant for subagent children: header only, never expandable.
- `subagent-card.tsx`: a `Collapsible` whose header is the chevron, `subagentLabel`, a muted
  `N tools · 34s · model` (or `Running in background` for a background dispatch) and a `Needs you` pill when
  blocked. Body: `windowChildren(children)` as header-only tool cards (permission children render as the existing
  one-line permission row). A blocked subagent forces itself open until the user collapses it.
- `tool-blocks.tsx` (evolves `tool-row.tsx`'s `ToolBody`): renders `ToolBlock`s: note (muted), field, command
  (`$ text`), path (+ muted hint), diff (green `+`, red `-`, clamped), todos (`✓` done muted and struck through,
  `◉` in progress, `○` pending), lines (clamped, red when error), json (clamped), image (`[image]`).
- `tool-glyphs.ts`: `ToolGlyph` → one terminal character: terminal `$`, file-pen `✎`, file-plus `+`,
  file-text `≡`, search `⌕`, folder-search `⌕`, globe `◍`, list-todo `☰`, bot `◆`, send `➤`, wrench `⚙`,
  image `▣`.
- `src/tui/ui/use-ticker.ts`: one shared interval for every animation. It starts when the first subscriber
  mounts and stops when the last unmounts. Spinner and the subagent's elapsed time both read it. A finished
  card and a closed subagent subscribe to nothing, so an idle transcript runs no timer.

Cards sit in the same 100-column measure as message blocks (`maxWidth`), with the margin outside.

### 4. Expansion state

`Transcript` keeps the `open` set (toggled by `Enter` on a tool row) and adds a `closed` set for cards the
user collapsed while they were forcing themselves open. A subagent's effective state is
`open || (blocked && !closed)`; toggling a forced-open card adds it to `closed`.

### 5. Cleanup

The termcn `tool-call` item and its rows in `src/tui/ui/termcn/PATCHES.md` are removed (nothing uses it). That
closes two deferred minors: the running timer measured from mount, and a stuck-running row spinning forever
(the shared ticker is one timer and stops with the last running card).

## Invariants kept

Nothing under `src/tui/` or `src/client-core/` imports `vscode`; `client-core` has no React or DOM;
`protocol/messages.ts` is untouched; session-addressed messages keep their `SessionId`; the TUI never writes a
session it does not own.

## Testing

- mocha (`src/test/unit`): `subagent-window` tests move with the file; `transcriptRows` tests updated for the
  one-row-per-top-level-tool model (children no longer rows).
- bun (`src/test/tui`): collapsible open/closed and selected border; tool card header per state (running,
  error with `failed`, ok with no mark), body Input/Result/Error sections, MCP chip, blocks; subagent card
  header summary, window of 10, forced open when blocked and stays closed after a user collapse, background
  dispatch wording; shared ticker starts one interval for many subscribers and none when idle.
  Tests assert frame strings, spans through `captureSpans` as strings/booleans, counts; never a renderable.
- Gates: `yarn lint`, `yarn check-types`, `yarn check-types:tui`, `yarn test:tui`, `yarn test:unit`
  (re-run on `listen EACCES`), `yarn test:dom` (the move touches webview imports). `build:tui:bin` is not run.
- `docs/tui.md` smoke checklist gains: a subagent run shows a card with a tool count and elapsed time; a failed
  tool shows the `failed` pill; light terminal legibility of the card borders.

## Risks

- **Row model change:** cursor behaviour is covered by the existing transcript tests, which must keep passing
  except where they assert the old flattened child rows.
- **Text clipping:** whether OpenTUI clips a long single-line `<text>` inside a flex row the way `truncate`
  does in CSS must be checked first; the fallback is slicing the primary to the available width.
- **Taller rows:** a collapsed card is three rows (border, header, border). Density drops again; the user has
  accepted webview parity over density.
