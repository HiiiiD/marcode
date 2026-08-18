# Marcode

Run several coding-agent sessions at once, in resizable split panes, in VS Code's
secondary sidebar. Tool-permission requests show up as cards in the transcript and are
answered from the UI. Transcripts survive a window reload.

It is an orchestrator, not another agent: it drives other vendors' coding-agent backends
(Claude, Codex, OpenCode) side by side, in one panel, rather than shipping its own agent
loop.

## Features

- A roster of concurrent agent sessions, each its own conversation with its own status,
  model, effort level and permission mode.
- Split panes over the visible subset of that roster, with a persisted layout.
- Tool-permission requests surfaced as cards in the transcript, answered from the UI.
- Durable transcripts, paged on demand, that survive a window reload.
- Three agent backends behind one interface: the Claude Agent SDK, the Codex CLI, and the
  OpenCode CLI over the Agent Client Protocol (ACP) — configurable via
  `marcode.enabledProviders`.
- A fleet diff review tab (**Marcode: Review fleet changes**) showing every session's
  changes against a base ref, attributed to the session whose tool calls made them.
- Context-usage and plan-usage indicators per session and per panel.

## Install

Two ways to run it: a throwaway Extension Development Host for iterating on the code, or a
packaged `.vsix` installed into your real VS Code.

Both start from a build. `dist/webview.css` is produced by the Tailwind plugin inside
`esbuild.js`, so any build script covers it — there is no separate CSS step.

```powershell
yarn install
```

### Extension Development Host

Press `F5` (**Run Extension** in `.vscode/launch.json`). It builds via the default task and
opens `.vscode/dev.code-workspace` — a separate window identity over this same folder, so
VS Code doesn't refuse the launch with an already-open-folder conflict.

To iterate, run `yarn watch` in one terminal (esbuild, `tsc --noEmit` and Tailwind in
parallel) and launch with `F5`. After a rebuild, reload the dev-host window with `Ctrl+R`.
Because the extension host owns all state and the webview is rehydrated from it, a reload
is a real test of persistence rather than a reset.

Fallback, for when the debugger itself is the problem or `--disable-extensions` is needed:

```powershell
yarn run compile   # esbuild + check-types + lint
yarn dev           # launches a separate VS Code with this repo as the extension
yarn dev:clean     # same, plus --disable-extensions
```

`yarn dev` runs [`scripts/dev-host.ps1`](scripts/dev-host.ps1), which strips every
inherited `ELECTRON_*` / `VSCODE_*` variable and starts a fresh instance under its own
profile in `%TEMP%\mar-devhost` — useful if launching `code` from an integrated terminal
inherits `ELECTRON_RUN_AS_NODE=1` and exits immediately. `F5`'s debug-launched extension
host doesn't hit that.

### Packaged `.vsix`

`package.json` has no `publisher` field yet, and `vsce` refuses to package without one. Add
any string — a local install does not need a real Marketplace account:

```jsonc
{
  "name": "mar-code",
  "publisher": "marcode",
  ...
}
```

Then:

```powershell
yarn run package              # check-types + lint + production bundle
npx @vscode/vsce package      # -> mar-code-0.0.1.vsix
code --install-extension mar-code-0.0.1.vsix
```

Reload the window afterwards. To remove it: `code --uninstall-extension marcode.mar-code`.

[`.vscodeignore`](.vscodeignore) excludes `node_modules/**` but re-includes
`@anthropic-ai/claude-agent-sdk` and its `win32-x64` native package, so the SDK ships
inside the `.vsix` — see the platform note below.

Transcripts live under the extension's storage path, which is per profile and per
workspace. The dev host and an installed `.vsix` therefore keep separate histories.

## Setup: move the panel to the secondary sidebar

VS Code extensions cannot place a view in the secondary sidebar directly, so this is a
one-time manual step:

1. Open the secondary sidebar — **View → Appearance → Secondary Side Bar**, or `Ctrl+Alt+B`.
2. Drag the **Marcode** icon from the activity bar into the secondary sidebar.
3. Widen it by dragging its inner edge — split panes need the room.

VS Code stores this per profile and workspace, so it only has to be done once. The
extension also ships a walkthrough with the same steps — open it from the Command
Palette with **Get Started: Open Walkthrough...** and pick "Set up the Marcode panel".

## Requirements

Each backend needs its own CLI installed and authenticated before starting a session —
this extension does not manage or prompt for authentication itself, except where noted:

- **Claude** — the `claude` CLI must be on PATH and authenticated.
- **Codex** — the `codex` CLI must be on PATH (or set via `marcode.codex.path`). Sign in
  from the Command Palette with **Marcode: Sign in to Codex**.
- **OpenCode** — the `opencode` CLI must be on PATH (or set via
  `marcode.opencode.path`).

Which providers this window registers is controlled by `marcode.enabledProviders`
(default `["claude", "codex", "opencode"]`); a provider left out is not probed and never
appears in the panel. Changing the setting requires a window reload.

## What v1 does not do

- No plan-usage windows or question-card support for the OpenCode backend — ACP carries
  no plan-usage data, and question cards are out of scope for v1.
- No transcript retention policy — transcripts accumulate under extension storage with
  no automatic pruning.
- No virtualized scrolling in the transcript view.

## Platform note

**This build runs on Windows x64 only.** The Claude Agent SDK ships its native binaries as
separate per-platform optional dependencies, and the packaged `.vsix` carries just the
Windows x64 one. Other platforms need a `.vsix` built with their own native package —
per-platform builds are not set up yet.
