# Webview DOM Testing — Design

Status: approved, not yet implemented.
Sequencing: land **after** the in-flight plans finish, so two branches don't both edit
`package.json` and the test scripts.

## Problem

Every existing unit test is a pure-function test: `reduce`, `reconcilePaneLayout`,
`isHostMessage`, the tool-card formatters. Nothing renders a component. So the behavior
that only exists once React has mounted is untested:

- `PermissionCard` disabling both buttons on the first click, before the host round-trips
- `PermissionCard` rendering a *pending* item as stale when the host no longer holds its
  `requestId`
- `Composer` submitting on Enter but not Shift+Enter, and clearing the textarea
- `App` posting `set-visible` after `hydrate` — the effect that keeps restored panes alive
- The Base UI portalled controls (`Select`, `DropdownMenu`) rendering at all

These are the parts most likely to regress, and the parts a reader of the reducer tests
would wrongly believe are covered.

## Scope

**In:** render and interaction correctness under jsdom — given host state, the right DOM;
given a user action, the right `WebviewToHost` message.

**Out:** visual/layout correctness (real CSS, pane resizing, scroll-follow) and real VS Code
webview transport. Both need a browser; neither is worth its cost yet. Transcript
virtualization is out for the same reason — jsdom computes no layout, so every measured
height is 0 and such a test asserts nothing real.

## Runner

Mocha, extended — not a second runner.

Two blockers stand between mocha and a `.tsx` test, both solvable:

- **JSX + the `@` alias.** `tsx/cjs` as a mocha require-hook compiles `.tsx` on the fly and
  resolves tsconfig `paths`, so `@/components/ui/button` resolves at runtime. esbuild is
  currently the only thing in the repo that understands `@`; this gives mocha the same
  ability. Side benefit: `test:unit` loses its `compile-tests` step and gets faster.
- **A DOM.** `global-jsdom/register` installs `window`/`document` globally before the first
  import.

New dev deps: `tsx`, `jsdom`, `global-jsdom`, `@testing-library/react`,
`@testing-library/user-event`. Nothing is removed.

`tsc --outDir out` stays. `.vscode-test.mjs` runs `out/test/integration/**/*.test.js`, so
`compile-tests` is still required by `pretest` for the integration suite.

### Split by environment, not per-file

jsdom is a process-global under mocha, so rather than fight it, split the scripts:

| Script | Command | Environment |
|---|---|---|
| `test:unit` | `mocha --ui tdd --require tsx/cjs 'src/test/unit/**/*.test.ts'` | node, no jsdom |
| `test:dom` | `mocha --ui tdd --require tsx/cjs --require global-jsdom/register --require src/test/dom/setup.ts 'src/test/dom/**/*.test.tsx'` | jsdom |
| `test` | unchanged (`pretest` + `vscode-test`) | VS Code |

`transcript-store` and `session-manager` — node-side code — never see a jsdom global at all.

### Why not vitest

Vitest was the first proposal and was rejected in favour of this. It would have brought a
second runner and vite for a comparable dependency count, split the repo's test idiom in
two, and needed `@vitest-environment node` docblocks to keep host-side tests off jsdom. The
script split above solves that more cleanly. The one genuine loss is `expect` and therefore
`jest-dom` matchers; assertions stay on `node:assert` against DOM nodes, which is what the
repo already writes.

## Mounting strategy

Every webview component reads `useStore()`; almost nothing takes props. So tests mount
components inside the **real** `StoreProvider` and drive them with genuine
`HostToWebview` messages. A test reads as: *host says X → user sees Y → user acts → host
receives Z*. The reducer stays in the loop; no application code is mocked.

The rejected alternative was exporting `StoreContext` and wrapping tests in a fake provider
with a hand-built `ClientState`. It is less setup, but it bypasses `reduce`, so a test can
pass against a state the host could never produce. `hydrate` carries full snapshots, so
nearly any state is one message away and the fake provider buys little.

## The harness

Two files under `src/test/dom/`.

### `setup.ts`

Loaded via mocha `--require`, before any spec:

- `globalThis.IS_REACT_ACT_ENVIRONMENT = true` — otherwise React 19 warns on every update
- polyfills absent from jsdom: `ResizeObserver` (needed by `react-resizable-panels`),
  `matchMedia` and `Element.prototype.scrollIntoView` (needed by Base UI)
- imports `harness.tsx` for its install side-effect
- a root `teardown()` running RTL `cleanup()` and `resetHost()`

The `teardown` hook is not optional. Under `--ui tdd` mocha exposes `teardown`, not
`afterEach`; React Testing Library probes for a global `afterEach` to install its automatic
cleanup and silently no-ops when it is missing, leaking the DOM between tests.

### `harness.tsx`

The seam. On import it installs `globalThis.acquireVsCodeApi`, returning a stub whose
`postMessage` pushes into a module-local array. This must happen before `vscode-api.ts`
evaluates — that module calls `acquireVsCodeApi()` at load time — which the `--require`
ordering guarantees.

Exports:

- `posted(): WebviewToHost[]` — everything the webview has sent
- `resetHost(): void` — clears the array
- `sendFromHost(...msgs: HostToWebview[]): void` — dispatches
  `new MessageEvent('message', { data: msg })` on `window`, inside `act()`
- `renderApp()` — mounts `<StoreProvider><App /></StoreProvider>`
- `renderWithStore(ui)` — mounts a single component under a real `StoreProvider`

`sendFromHost` uses `dispatchEvent`, deliberately not `window.postMessage`: jsdom queues
`postMessage` asynchronously, which makes assertions racy. A direct dispatch is synchronous
and deterministic, and `onHostMessage` cannot tell the difference.

`StoreProvider` posts `{ t: 'ready' }` on mount, but `posted()[0]` is not reliably that
message: React flushes child effects before parent ones, so under `renderApp` every effect
in `App` — including the one that posts `set-visible` — runs before `StoreProvider`'s own
`ready` post. Tests asserting the effect of a click read `posted().at(-1)`; tests that need
the `ready` handshake filter by `t` rather than indexing.

### Required refactor

`main.tsx` defines `App` and calls `createRoot(...).render(...)` at module scope. Importing
it from a test would mount a second root against a `#root` that does not exist. Extract
`App` to `src/webview/app.tsx`; `main.tsx` keeps only the import and the mount. This is the
seam that makes whole-app tests possible.

### Shared fixtures

`webview-reducer.test.ts` hand-rolls a local `summary()` builder. Lift it, plus a
`snapshot()` builder, to `src/test/fixtures/protocol.ts`, consumed by both suites.
Otherwise the DOM tests grow a parallel set that drifts from the unit tests'.

## Tests

Ordered so the stack proves itself on the richest target first.

### 1. `permission-card.test.tsx`

- pending, with its `requestId` in `state.byId[id].pending` → Allow and Deny render enabled;
  clicking Allow posts `permission-decision` with `decision: { allow: true }`, and clicking
  Deny posts `decision: { allow: false, reason: 'Denied by user' }`
- after one click both buttons are disabled, with no host round-trip — the `answered` local
  state, invisible to a unit test, guarding the double-click case
- pending item whose `requestId` is *not* in `pending` → renders "no longer awaiting a
  response" with both buttons disabled
- `state !== 'pending'` → one-line summary, no buttons
- `diffPreview`: input carrying `file_path` plus `old_string`/`new_string` renders the
  `--- path` header and the `-`/`+` lines

### 2. `composer.test.tsx`

- Enter posts `{ t: 'send' }` and clears the textarea; Shift+Enter inserts a newline and
  posts nothing
- whitespace-only text → Send disabled, nothing posted
- status `running` → Stop replaces Send; clicking it posts `interrupt`
- `model.effort` undefined → no Effort select; defined → changing it posts `set-effort`

### 3. `app-boot.test.tsx`

Whole-app, via `renderApp()`:

- mount posts `ready`; with `state.ready` false the view renders "Loading…"
- after `hydrate`, panes render and `set-visible` is posted carrying the layout's session
  ids — the behavior the `paneIdsKey` effect exists to guarantee

### 4. `session-picker.test.tsx`

Toggling a session posts `set-layout`. Doubles as the canary for Base UI's portal and the
`matchMedia` / `scrollIntoView` polyfills.

### 5. `pane-group.test.tsx`

One pane per layout entry, with the correct titles. Thin — its real job is proving the
`ResizeObserver` polyfill holds under `react-resizable-panels`.

## Supporting changes

- `eslint.config.mjs` — cover `src/test/dom/**` with the `.tsx` parser settings
- `tsconfig.json` — DOM tests must typecheck under `check-types`
- No `.mocharc` file: the two scripts carry their own flags, since a shared rc would have to
  be overridden by both
- `CLAUDE.md` — the **Tests** line becomes: mocha unit / mocha + jsdom DOM / vscode-test
  integration

## Risk

`tsx/cjs` resolving tsconfig `paths` is the load-bearing assumption. The first
implementation task is a throwaway probe: one trivial test importing `@/lib/utils` through
the hook. If it fails, the fallback is an esbuild-backed alias resolver registered as a
require hook — same design, different two lines.
