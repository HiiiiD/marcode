# TUI: adopt termcn visuals

Branch: `feat/tui-termcn`, branched from `feat/tui-features` (bfac58c).

## Background

The v1 TUI spec (line 14) says "OpenTUI with termcn-style copy-paste components", but every TUI
component is hand-written `<box>`/`<text>`. This spec makes that real.

termcn ([github.com/shadcn-labs/termcn](https://github.com/shadcn-labs/termcn), MIT) is a shadcn-format
registry with an `opentui/` namespace (~190 items, ~45 of them themes). An item is a single self-contained
`.tsx` using `@opentui/react`, plus a shared `use-theme` hook. Items are served as
`https://termcn.dev/r/opentui/<name>.json`.

## Goal

Better-looking TUI using termcn visuals, with no behavioural regression. The 160 existing TUI tests stay
the safety net. Our zone keymap (`src/tui/keymap.ts`) stays the single key authority.

In scope: dialogs and confirms, transcript rows, roster rows and attachment chips, a shared theme layer.

Out of scope: replacing the native `<scrollbox>` and `<markdown>` in the transcript (termcn's `chat-thread`,
`scroll-view` and `markdown` have no sticky-bottom, viewport culling, prepend anchoring or tree-sitter
highlighting); `streaming-text`; `token-usage` (raw token counts break the percentages invariant);
`usage-monitor` and `ContextMeter` (sub-project D); `file-change` (sub-project E); `tool-approval` and
`model-selector` (our approval prompt has deny-with-reason, and model switching is Ctrl+P).

## Design

### 1. Vendoring

- Files live in `src/tui/ui/termcn/`, copied by hand from the registry JSON. No shadcn CLI and no second
  `components.json`: the existing one configures the webview, and its `@/*` alias maps to `src/webview/*`.
- Imports are rewritten to relative paths. Each file starts with a one-line header naming the registry item.
- Initial items: `types`, `use-theme`, theme provider with the default theme, `dialog`, `confirm`, `tag`,
  `tool-call`, `chat-message`, `status-message`. The first task reads every item's full render code; an
  item that does not fit is dropped from the list.
- No new runtime dependency. `@opentui/react` is already installed, so the Bun build and the compiled binary
  are unaffected.

### 2. Key ownership

Stock termcn components call `useKeyboard` unconditionally and would double-handle keys against the keymap.
Each vendored interactive component gets one patch: `active?: boolean` (default `true`), checked first in its
`useKeyboard` callback. The keymap's owners pass it: the roster `focused && !filtering`, a dialog `open`.
Presentational items (`tag`, `status-message`) need no patch.

Components that hold their own cursor (`list`, `select`, `menu`) are not used for the roster or the
new-session flow: both keep their own cursor logic and borrow only visuals.

### 3. Theme

One `src/tui/ui/termcn/theme.ts` maps our current colour names (`gray`, `cyan`, `yellow`, `red`, `green`)
into a termcn theme, so light terminals stay legible and every vendored component reads one palette.
No theme presets are vendored beyond the default.

### 4. Surfaces

- **Dialogs:** `new-session-dialog.tsx` uses the `dialog` frame; the provider-then-model state and `j/k`
  remain ours. `delete-confirm.tsx` uses `confirm` (danger variant), gated by `active`. It stays in the
  bottom slot.
- **Transcript:** `row.tsx` wraps rows in `chat-message` (role gutter) and tool rows in `tool-call`
  (status glyph, duration). Cursor, expansion and `scrollChildIntoView` stay in `Transcript`, passed down as
  controlled props. `<scrollbox>` and `<markdown>` are unchanged. Extra border or padding rows must not make
  the visible transcript noticeably shorter; decide per row type from real renders.
- **Roster and chips:** termcn row styling and `tag` chips. Cursor-by-id, filter mode, `p`/`x`/`D`, foreign
  dimming and `setRosterFiltering` are unchanged.

## Invariants kept

Nothing under `src/tui/` imports `vscode`; `client-core` is untouched; `protocol/messages.ts` stays
types-only; session-addressed messages keep their `SessionId`; errors stay state.

## Testing

- Existing `src/test/tui` frame assertions are updated deliberately where glyphs or borders change; each
  change is reviewed, not bulk-regenerated.
- New tests: a component with `active={false}` ignores keys; the theme maps every colour name the TUI uses.
- Tests never hand a renderer or renderable to an assertion, never mock the store, and feed genuine
  `HostToWebview` messages through `src/test/tui/harness.tsx`.
- Gates: `yarn lint`, `yarn check-types`, `yarn check-types:tui`, `yarn test:tui`, `yarn test:unit`
  (re-run on `listen EACCES`). `yarn build:tui:bin` is not run.
- `docs/tui.md` gains a short note on the vendored components, and the manual smoke checklist gains a light
  terminal legibility check.

## Risks

- **Frame churn:** many assertions change; mitigated by updating them one surface at a time.
- **Row chrome height:** `tool-call` and `chat-message` add rows; per-row-type decision, with a fallback to
  keeping the current one-line row.
- **Drift from upstream:** accepted, as in shadcn. Headers name the source item for later re-sync.
- **Unread render code:** only prop signatures and sizes were reviewed during research; the first plan task
  is a full read pass.
