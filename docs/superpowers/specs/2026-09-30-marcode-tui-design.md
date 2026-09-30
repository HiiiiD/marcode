# Marcode TUI

Sub-project 2 of the Marcode TUI. Builds on [shared storage and a vscode-free host](2026-09-30-shared-storage-headless-host-design.md).

## Goal

A terminal-native user runs `marcode` in a repo and gets the same sessions a VS Code window on that workspace has: create or resume a session, stream a turn, answer tool approvals and questions, and see sessions owned by another host live and read-only.

Success: `cd repo && marcode` resumes the last session; a turn streams with the view pinned to the bottom; an approval is answered from the keyboard; a session running in VS Code shows as foreign with a read-only banner; none of it needs VS Code installed.

## Decisions

- **Audience:** terminal-native users. No daemon. The TUI runs its own in-process host via `createHost({ hostKind: 'tui' })` over the shared `~/.marcode/workspaces/<slug>/`. Workspace key is the git root of the cwd, else the cwd.
- **UI stack:** OpenTUI (`@opentui/react`) with termcn-style copy-paste components.
- **Runtime:** Bun. OpenTUI runs on Bun >= 1.3 or Node >= 26.4 with `--experimental-ffi`, and is ESM-only; it cannot run on the extension's Node 22 CJS bundle. The TUI is its own ESM bundle, shipped as `bun build --compile` binaries per platform. The extension bundles are unchanged.
- **v1 scope:** single pane. Roster, one transcript, composer, tool approvals and questions, new session, model/effort/permission-mode switching, foreign-session read-only label.
- **Client state:** shared `client-core`, not a new reducer and not an import from `src/webview/` in place.
- **Navigation:** toggleable roster sidebar (overlay on narrow terminals).
- **Approvals:** a focus-trapping prompt that replaces the composer.
- **Foreign sessions:** read-only with live tail and a banner. No fork-to-take-over in v1.
- **Login and config:** `marcode login <provider>` and `marcode config` subcommands; the TUI shows the exact command and re-probes on `r`. A config change needs a restart.
- **Testing:** three layers (pure logic on mocha, components and end-to-end on `bun test`).
- **Launch:** resume-first, with a one-shot prompt argument.

## Out of scope for v1

Split panes; fleet, review and history tabs; context dialog; usage strip; attachments and image paste; `@` mentions; handoff seeds; worktree and relocation cards (rendered as a read-only one-line item); mouse; in-TUI login by suspending the renderer; forking a foreign session; Windows arm64 packaging.

## Architecture

```
bin: marcode (bun --compile)        src/tui/main.ts
  ├─ cli.ts        [prompt] | --new | login <provider> | config | migrate <dir>
  ├─ boot.ts       resolveWorkspaceDir(gitRoot ?? cwd) -> loadConfig -> createHost({ hostKind: 'tui' })
  │                -> MessageRouter(manager, emit, cwd, editor stubs, configHost -> config.json)
  ├─ transport.ts  in-process ClientTransport: post -> router.handle, onMessage <- emit
  └─ ui/           app, roster, transcript/, composer, approval-prompt, question-prompt,
                   new-session-dialog, empty-state, status-line, keymap

src/client-core/   moved from src/webview, re-exported at the old paths
  reducer.ts, layout-tree.ts, tool-render.ts, tool-card-format.ts, draft-store.ts,
  owner-reason.ts, provider-availability.ts, transport.ts (the ClientTransport interface)
```

`client-core` is pure, runtime-neutral TypeScript: no React, no `vscode`, no DOM. The webview's `store.tsx` swaps `vscode-api` for a `ClientTransport`; the TUI store does the same over the in-process one. `MessageRouter` already imports `layout-tree` from the webview tree, so the move only makes an existing dependency honest.

Router wiring: the `EditorContextHost` hooks are no-ops except `openExternal` and `login` (the latter surfaces the recipe command in the empty state instead of opening a terminal). `ConfigHost.setFavoriteModels` writes `config.json`. No `FileSearch` in v1.

Visible set: the TUI keeps exactly one visible session, the focused one. A focus change posts `set-visible [id]` and `focus-pane`, and the store mirrors `local-layout`. The focused id is persisted in `layout.<host>.json` (per-host layout from sub-project 1). Status for other sessions comes from `sessions-changed` and `session-status`, which are ungated.

## UI

Wide (>= 100 columns): roster column, transcript, bottom slot, status line. Narrower: the roster is an overlay.

- **Roster row:** status glyph (running, idle, error, `!` for a pending approval or question, dimmed for foreign), title, and `host·pid` for a foreign session. Order is the host's.
- **Bottom slot:** one component, four exclusive modes in priority order: pending question on the focused session (blocking first), pending permission request, foreign banner ("Running in vscode (pid N), read-only"), composer. The draft lives in `draft-store` and posts `set-draft`, so a prompt survives an approval interrupting it.
- **Status line:** provider, model, effort, permission mode, and context share when a breakdown is already in state. Shares are percentages; the context dialog's token window line is deferred with the dialog.
- **Focus zones:** roster, transcript, bottom slot. `Tab` cycles; the bottom slot is the default.

### Transcript

- Assistant text is streaming `<markdown>`. Code-block highlighting covers only the languages OpenTUI bundles; others render plain.
- Each tool call is one header line from `tool-render` (`▸ Edit src/a.ts  +12 −3`). `Enter` on the selected item expands it inline: a `<diff>` for edits, a clamped output block for commands.
- `<scrollbox>` with `stickyScroll` from the bottom and viewport culling. Scrolling up stops the follow; `End` re-pins. Reaching the top posts `load-more`.

### Keymap

One table in `keymap.ts`. Defaults:

| Zone | Keys |
|---|---|
| Global | `Ctrl+B` roster, `Ctrl+N` new session, `Ctrl+C` interrupt if running else press twice to quit, `Esc` interrupt, `Ctrl+P` model, `Ctrl+E` effort, `Shift+Tab` permission mode |
| Composer | `Enter` send, `Ctrl+J` / `Alt+Enter` newline, `Up` at start recalls prompt history |
| Transcript | `j/k` item, `Enter` expand or collapse, `PgUp/PgDn`, `End` re-pin |
| Roster | `j/k`, `Enter` focus, `x` hide, `r` rename |
| Approval | `y` allow, `n` deny then optional reason, `Enter` runs the highlighted option |
| Question | `Up/Down`, `Space` toggle (multi-select), `Enter` submit, text field for free-text, masked for `secret` |

Shift+Enter depends on the terminal's keyboard protocol, so `Ctrl+J` and `Alt+Enter` are the portable newline chords.

A permission answer is `{ allow: true } | { allow: false, reason? }`; a question answer is `Record<questionId, string[]>`.

### Launch and states

- `marcode` opens the last-focused session for the workspace; with none, an empty state with the composer focused and a provider picker above it.
- `marcode "fix the tests"` creates a session with the default provider and sends the prompt through the router's `create-session` seed. `marcode --new` forces a new session.
- `Ctrl+N` opens a compact dialog: provider, then model; effort and permission mode default to the last choice. A new session's cwd is the launch cwd, not the git root.
- **Probing:** "Checking providers…" while `probing` is true.
- **No provider available:** each provider's reason and its login command; `r` re-probes (`refresh-catalog`). With no provider enabled, it points at `marcode config`.
- **Session `error`:** the error item renders as usual and the composer stays usable.
- **Queued sends:** dimmed lines above the composer, cancellable (`cancel-queued`).

## Data flow and lifecycle

1. `boot` resolves the workspace dir, loads `config.json`, calls `createHost` with `emit` bound to the transport, and builds the `MessageRouter`.
2. The store posts `ready`; the router answers `hydrate`. `boot` has applied `layout.tui.json` first so the focused session is the only leaf.
3. `send` goes through the router; deltas return as `session-patch` via `emit`, then `reduce`, then a render.
4. Shutdown (`Ctrl+C` twice, `SIGINT`, `SIGTERM`): `renderer.destroy()` first to restore the terminal, then `host.dispose()` (leases released, self-control server stopped, store closed). A second signal during dispose exits at once.

### Errors are state

- A failing provider puts the session into `error` with a transcript item; the TUI renders it. `router.handle` catches everything, so nothing rejects into the renderer.
- A boot failure (unreadable `config.json`, unwritable workspace dir) prints one line to stderr and exits non-zero before the renderer starts, so a raw-mode terminal is never stranded. After the renderer starts, problems go through `notify.warn` to a dismissible status-line notice.
- `uncaughtException` and `unhandledRejection` destroy the renderer first, then print and exit.

### Concurrency with VS Code

Inherited from sub-project 1. A session leased by another live host is foreign: live tail, banner, no approvals, no composer. A session created in the TUI is owned by the TUI; closing the TUI releases the lease and the other host's next `send` claims it. `config.json` is read once at boot; if the file watcher sees a change, the status line says to restart.

## Invariants kept

- `src/protocol/messages.ts` stays types-only.
- Nothing under `src/tui/` or `src/client-core/` imports `vscode`.
- Every message addressed to a session carries an explicit `SessionId`.
- Errors are state, never exceptions.
- Transcript patches fan out only to visible sessions; the TUI's visible set is its one focused session.
- A host never writes a session it does not own.
- `config.json` is the single source of truth for host settings.

## Testing

- **Mocha, pure logic (`yarn test:unit`):** `keymap`, roster row view-model, bottom-slot mode selector, transcript item to row model, `cli` argument parsing, and the existing reducer tests run unchanged against `client-core` (proving the re-exports).
- **`bun test` with `testRender` (`yarn test:tui`):** component tests through a real store and the in-process transport, fed genuine `HostToWebview` messages; assertions compare `captureCharFrame()` text and the messages posted back. Covered: streaming text pinned to the bottom, scrolling up stops the follow, expanding a tool card into a diff, approval answers post `permission-decision`, question prompt (single, multi, secret), foreign banner, probing/empty/unavailable states, a draft surviving an approval interrupt. Never mock the store or hand-build `ClientState`.
- **End to end (`bun test`):** real `createHost` with `FakeProvider` on a temp `MARCODE_HOME`: a full turn, the permission fixture, and two hosts on one workspace where one session is owned and the other sees it foreign and read-only.
- **Guards:** `yarn test:tui` runs through the RAM guard, extended to wrap `bun`. A check script bans passing renderables to `assert`, like `check-dom-null-asserts`.
- **Bun-compat spike (task zero of the plan):** `createHost` under Bun 1.3.x with `FakeProvider`, then each real provider's spawn and ACP ESM loading, then `node:sqlite`. Fallback if `node:sqlite` fails: memory off in the TUI (`memory.enabled = false`) or a runtime-picked sqlite adapter. The result is recorded in the plan.
- **Manual smoke:** Windows Terminal and one macOS or Linux terminal: resize, paste, `Ctrl+J` and `Alt+Enter`, colour, clean exit on `Ctrl+C`.

## Build and release

`dist/tui.js` (ESM, Bun target) for development; `bun build --compile` for per-platform `marcode` binaries. `tsconfig` gains a TUI project with Bun types and ESM. `yarn lint`, `yarn check-types` and `yarn run compile` keep passing for the extension. CI matrix and publishing are a later task in the plan, not v1 code.

## Risks

- Bun compatibility of the host (above); the spike gates the plan.
- Shift+Enter and modifier chords vary by terminal; mitigated by `Ctrl+J` and `Alt+Enter`.
- Windows Terminal behaviour is covered only by the manual checklist.
- Tree-sitter highlighting covers a limited set of languages.
- OpenTUI is young; pin the version and record the tested one in the plan.

## References

- OpenTUI [runtime support](https://opentui.com/docs/getting-started/runtime-support/), [standalone executables](https://opentui.com/docs/reference/standalone-executables/), [testing](https://opentui.com/docs/core-concepts/testing/), [ScrollBox](https://opentui.com/docs/components/scrollbox/), [Markdown](https://opentui.com/docs/components/markdown/), [Textarea](https://opentui.com/docs/components/textarea/), [React bindings](https://opentui.com/docs/bindings/react/)
- [termcn](https://www.termcn.dev/docs)
