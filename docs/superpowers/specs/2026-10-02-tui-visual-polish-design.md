# TUI visual polish

Bring the visual quality of OpenCode's TUI (`anomalyco/opencode`, `packages/tui`) to the Marcode
TUI: tinted left-bar panels, a semantic color token set, native highlighted diffs, and highlighted
markdown/code. The OpenCode TUI is Solid-based; ours is React on `@opentui/react` 0.5.13, so ideas
are translated, not copied.

## Goal and constraints

- Tinted panels, diff/markdown/syntax tokens, `<diff>` with line numbers and split/unified by width,
  syntax-highlighted code in markdown and diffs.
- Must work on light and dark terminals. `tui-theme.tsx` uses named ANSI colors on purpose; hardcoded
  hex would break light terminals. RGB values are therefore **derived from the terminal's own
  palette** (`renderer.getPalette()`), not shipped.
- If the terminal does not answer, rendering is exactly what it is today.
- Keyboard, selection, collapse and permission behavior do not change.
- `client-core/tool-render` stays the source of tool blocks; the webview must not change.

## Out of scope

- Sidebar/home plugin registry and new sidebar panels (deferred; no second panel exists to host).
- Bundled theme files and any `config.json` setting.
- Replacing the termcn theme: termcn components keep the named-color theme, so `termcn/PATCHES.md`
  is untouched.

## Design

### 1. Tokens: `src/tui/ui/tokens/`

- `derive-tokens.ts`: pure `deriveTokens(colors: TerminalColors): TuiTokens` (RGBA values).
  - Surfaces `panel`, `menu`, `element`: terminal background mixed 4–8% toward the foreground.
  - Diff: `addedBg`, `removedBg` (background mixed with the palette green/red), line-number
    backgrounds, sign colors, `contextBg`.
  - Syntax: comment, keyword, string, number, function, type, taken from the 16-color palette.
  - Markdown: heading, link, code, quote.
- `tokens-provider.tsx`: `TokensProvider` and `useTokens()` returning `TuiTokens | undefined`.
  Created in `main.tsx`; awaits `renderer.getPalette()` with a short timeout. Failure or timeout
  yields `undefined`, and every consumer falls back to today's rendering.
- `syntax-style.ts`: builds the OpenTUI `SyntaxStyle` from the syntax and markdown tokens. Replaces the
  empty `SyntaxStyle.create()` in `transcript/row.tsx`.

### 2. Panels: `transcript/panel.tsx`

- `Panel` replaces `Collapsible`'s four-sided frame: left bar only, `panel` tint, padding.
- Selected row: `menu` tint and a primary-colored bar (today: primary border color).
- The message `Bar` in `row.tsx` uses the same treatment. Without tokens: today's plain bar and frame.
- `ChatMessage`, `PermissionCard`, `SubagentCard` keep their logic; only the frame changes.

### 3. Native diff and code

- `client-core/tool-render.ts`: the `diff` block gains `unified?: string` with hunk headers kept.
  `lines` is unchanged, so the webview is unaffected.
- `transcript/tool-blocks.tsx`: with tokens and a `unified` string, render
  `<diff view filetype showLineNumbers>`; otherwise the current colored-line fallback.
- View is `split` when the pane is wider than 120 columns, else `unified`. Width is the pane's, not
  the terminal's, because panes resize. Pure helper `diffView(width)`.
- Existing head/tail clamping and the "N lines hidden" note are preserved.
- `util/filetype.ts`: extension to OpenTUI filetype.

## Testing

- mocha unit: `deriveTokens` (light and dark inputs, mix ratios, contrast floor), `diffView`,
  `filetype`.
- `yarn test:tui` (bun): `Panel` and the diff/code render paths, with and without tokens. Per the
  repo rule, never pass a renderer or renderable to an assertion.
- Gates: `yarn lint`, `yarn check-types`, `yarn check-types:tui`, `yarn run compile`.

## Risks

- `getPalette()` can be slow or unsupported in some terminals or multiplexers: bounded by the timeout,
  with a no-tokens fallback.
- `<diff>` needs a well-formed unified diff. Providers that give no `unifiedDiff` keep the fallback.
- A near-invisible tint on low-contrast terminals: the contrast floor in `deriveTokens` is unit-tested.
