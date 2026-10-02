# TUI Phase D: awareness

Roadmap item D. Brings the context dialog, a context share, the usage strip and relocation cards to the TUI at
webview parity. Two slices, one spec, one plan and PR each.

## Goal

A TUI user sees how full a session's context is, how much plan usage is left, and can answer a worktree move offer,
without opening the webview.

## Constraints (from AGENTS.md)

- Every share is a percentage. The only token count is the context dialog's window line (`usedTokens` / `windowTokens`).
- Plan usage is pulled (`refresh-usage`, `usage-windows`), never read off `rate_limit_event`.
- Nothing under `src/tui/` or `src/client-core/` imports `vscode`; `client-core` has no React or DOM.
- Every session-addressed message carries a `SessionId`.
- TUI tests never hand a renderer or renderable to an assertion; no fixed sleeps in new tests.
- No protocol or host changes. Everything needed is already on the wire and in `client-core` state
  (`contextBySession`, `usageByProvider`, `usageRefreshing`-style flag, `summary.contextPercent`).

## Out of scope

Memory-file editing from the dialog, usage mirrors configuration, mouse drag on the strip, a duration on relocation
cards (the protocol carries only `ts`).

## Slice 1: context

### Status-line share

`status-line.tsx` appends `ctx N%` from `summary.contextPercent`. Red at `DANGER_PERCENT` (80) or above, with the
percentage always printed so colour is never the only signal. Omitted when `contextPercent` is `undefined`.
When width is tight the order of loss is: picker hint, then `ctx`, then the existing tail ellipsis.

`DANGER_PERCENT` moves from `src/webview/components/context-dialog.tsx` to `src/client-core/context-format.ts`;
the webview imports it from there.

### Context dialog

- `src/client-core/context-format.ts` (pure): `ContextResult` to a dialog model: a header line, the percent bar
  value, one row per slice with its percentage, memory rows with percentages, and the single window line
  `usedTokens / windowTokens` when the provider reported both. Also holds `DANGER_PERCENT`.
- `src/tui/ui/context-dialog.tsx`: follows the `model-dialog.tsx` pattern (focus-owning overlay, Esc closes).
  Opens by posting `request-context { id }` and renders `contextBySession[id]` with three states: loading,
  `ok: false` reason, and the breakdown.
- Triggers: `/context` slash command, a chord (candidate `Ctrl+K`; planning checks it against `use-app-keys.ts`,
  `pane-keys.ts` and the multiplexer-safe set before fixing it), and a mouse click on the status-line share.
  The click uses the same pure hit-test approach as the divider drag so it can be tested without a renderer.
- Slash-command registration and the dialog open state live where `/model` `/effort` `/mode` already do.

## Slice 2: usage strip and relocation cards

### Usage strip

- `src/client-core/usage-format.ts` (pure): `usageByProvider` to rows. Windows ordered by `orderWindows`
  (`src/shared/usage-windows.ts`), percent from the structured 0 to 100 scale already normalised by the host,
  reset countdown from `resetsAt`. Providers with no windows produce no row.
- `src/tui/ui/usage-strip.tsx`: a roster header block, one row per provider: name, then per window a label, a
  small bar and the percentage, then the reset countdown. Hidden entirely when there are no rows.
- Refresh: a key (and a click on the strip) posts `refresh-usage`; the strip shows a refreshing marker until
  `usage-refresh-done`. Countdown text ticks through `use-ticker.ts`, which already runs only while a subscriber
  is active.
- Boot needs no work: `hydrate` already carries `usage`.

### Relocation cards

- `transcript-rows.ts` stops rendering `relocation` as a one-line notice and emits a card row instead.
- `src/tui/ui/transcript/relocation-card.tsx` on the tinted `panel.tsx` frame, states mirroring the webview card:
  - `pending`: the offer text and key hints. Accept posts `answer-relocation { id, itemId, move: true }`,
    decline posts `move: false`.
  - in flight: a cancel hint, posting `cancel-relocation { id, itemId }`.
  - settled (moved, declined, cancelled): muted one-liner, no keys.
- Card keys are live only on the focused pane and only while a relocation item is pending, so several panes never
  contend for the same key. The view model picks the item, so the component holds no state machine of its own.
- A pure `relocation-view.ts` in `src/tui/view/` maps the transcript item to card state. The webview's rule
  for what "pending" means is reused, not re-derived; if it sits in webview code it moves to `client-core` first.

## Testing

- Mocha, pure: `context-format`, `usage-format`, `relocation-view`, status-line width truncation including the `ctx`
  drop order, the status-line click hit-test.
- `bun test`, real loopback messages through the store: context dialog loading, error and ok states, the
  `request-context` post; usage strip hidden, shown, refresh marker; relocation card accept, decline, cancel and the
  focused-pane-only rule. Assertions read strings, counts and posted messages only.
- Both slices keep `yarn lint`, `yarn check-types`, `yarn check-types:tui`, `yarn test:unit`, `yarn test:tui` green.

## Risks

- Key collisions: the context chord and the usage-refresh key must not shadow `Ctrl+W` chords or the composer.
  Planning enumerates the bound set first.
- Roster width: the strip competes with roster rows in a narrow column. It truncates labels before bars and
  collapses to percent-only below a minimum width.
- Not verified in a real terminal: mouse click hit-testing on the status line. The chord and slash command are the
  complete fallback.
