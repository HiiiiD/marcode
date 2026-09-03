# Marcode

Run several coding-agent sessions at once, in resizable split panes, in VS Code's
secondary sidebar. Tool-permission requests show up as cards in the transcript and are
answered from the UI. Transcripts survive a window reload.

It is an orchestrator, not another agent: it drives other vendors' coding-agent backends
(Claude, Codex, OpenCode) side by side, in one panel, rather than shipping its own agent
loop.

## Features

- Cross-session messaging: a session can list the sessions open in a split pane
  (`marcode__list_sessions`) and send one a message (`marcode__send_message`) — across
  providers, so a Claude session can hand work to a Codex or OpenCode session, or check in
  on it, without you relaying anything by hand. Ask for it by naming the pane/session, not
  just "the other agent" — that phrasing can get confused with your harness's own
  agent-to-agent messaging, if it has one:
  - "Message the codex-2 pane and ask if it's finished the migration."
  - "Ask the other session in this panel whether it's still running tests."
  - "Tell the OpenCode session to pull latest before it starts."
- A roster of concurrent agent sessions, each its own conversation with its own status,
  model, effort level and permission mode.
- Split panes over the visible subset of that roster, with a persisted layout.
- Tool-permission requests surfaced as cards in the transcript, answered from the UI.
- Durable transcripts, paged on demand, that survive a window reload.
- Three agent backends behind one interface: the Claude Agent SDK, the Codex CLI, and the
  OpenCode CLI over the Agent Client Protocol (ACP) — configurable via
  `marcode.enabledProviders`.
- Extra named instances of a backend (`marcode.providerInstances`) — a second Claude
  account, a Codex instance pointed at a different `CODEX_HOME`, an OpenCode instance
  against a different config — each with its own binary path and secrets sourced from OS
  env vars, never stored in settings.
- A fleet diff review tab (**Marcode: Review fleet changes**) showing every session's
  changes against a base ref, attributed to the session whose tool calls made them.
- A fleet view (**Marcode: Open fleet view**) for drilling into one session's running or
  finished subagents in a focused list, linked from a subagent card in the sidebar.
- Cross-provider memory: any session can recall relevant snippets from your previously
  closed sessions (`marcode__recall` / `marcode__recall_fetch`) without reloading full
  transcripts into context.
- Self-control: a session can spawn a new Marcode session for itself — provider, model,
  permission mode, cwd and an initial prompt — via a local `marcode__spawn_session` MCP
  tool (blocked from spawning in unrestricted `bypass` mode).
- One-click reauth from the panel when a Claude or Codex login expires — no need to leave
  the extension to run the CLI's sign-in flow.
- Context-usage and plan-usage indicators per session and per panel.
- A CLAUDE.md/AGENTS.md drift nudge: flags directories where the two have drifted (one
  has real content, the other is missing) and offers a one-click migrate to make
  AGENTS.md the source of truth with CLAUDE.md as a `@AGENTS.md` stub. Scanned paths
  beyond the built-in node_modules/.git/dist/out excludes are configurable via
  `marcode.agentsMdNudge.excludePaths`.

## Install

Published on the VS Code Marketplace as **Marcode** (publisher `HiiiiD`) — search
"Marcode" in the Extensions view, or:

```powershell
code --install-extension HiiiiD.mar-code
```

CI builds and publishes a separate `.vsix` per platform/arch (Windows, macOS, Linux glibc
and musl, each x64 and arm64) on every tagged release, so the Marketplace install carries
only your platform's native binary — see the Platform note below. Per-platform `.vsix`
files are also attached to each [GitHub release](../../releases) if you'd rather install
one directly with `code --install-extension <file>.vsix`.

To remove it: `code --uninstall-extension HiiiiD.mar-code`.

The rest of this section is for working on the extension itself: a throwaway Extension
Development Host for iterating on the code, or building your own local `.vsix`.

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

If the debugger itself is the problem or `--disable-extensions` is needed, launch via a
VS Code task instead of `F5` — add one to `.vscode/tasks.json` running
`code --extensionDevelopmentPath=. .vscode/dev.code-workspace [--disable-extensions]`.

### Building your own `.vsix` locally

```powershell
yarn run package              # check-types + lint + production bundle
npx @vscode/vsce package      # -> mar-code-<version>.vsix, native deps for your host platform only
code --install-extension mar-code-<version>.vsix
```

Reload the window afterwards.

[`.vscodeignore`](.vscodeignore) excludes `node_modules/**` but re-includes
`@anthropic-ai/claude-agent-sdk` and whichever platform-specific native package `yarn
install` fetched for the machine you're packaging on — see the Platform note below. A
plain local `vsce package` (no `--target`) therefore only ever produces a `.vsix` for your
own platform; the per-platform CI matrix (`--target win32-x64`, `--target darwin-arm64`,
etc.) is what produces the others.

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

- **Claude** — the `claude` CLI must be on PATH and authenticated, same as running it
  standalone in a terminal: either `claude login` (browser OAuth, stored in the CLI's own
  config dir), or an `ANTHROPIC_API_KEY` **set as an OS environment variable before VS
  Code starts** (`setx ANTHROPIC_API_KEY "sk-ant-..."` on Windows, then relaunch VS Code
  so it inherits the new value). Marcode doesn't read or store this key itself — the
  default Claude backend spawns `claude` with the same environment VS Code was launched
  with, unchanged. If login expired, use the panel's own **Log in** action (see Features)
  or the Command Palette's **Marcode: Sign in to Claude**. `marcode.providerInstances` is
  only for *extra* accounts beyond this default one — see below.
- **Codex** — the `codex` CLI must be on PATH (or set via `marcode.codex.path`). Sign in
  from the Command Palette with **Marcode: Sign in to Codex**.
- **OpenCode** — the `opencode` CLI must be on PATH (or set via
  `marcode.opencode.path`).

Which providers this window registers is controlled by `marcode.enabledProviders`
(default `["claude", "codex", "opencode"]`); a provider left out is not probed and never
appears in the panel. Changing the setting requires a window reload.

### Provider instances: setting secrets

`marcode.providerInstances` holds no secrets itself — each entry's `envMap` maps a
subprocess env var name to the name of an **OS environment variable** to read the real
value from at launch. The value never sits in `settings.json`.

1. Set the OS env var first, then start (or restart) VS Code from that same environment —
   a shell already open before you set it won't see the change:

   ```powershell
   setx ANTHROPIC_API_KEY_WORK "sk-ant-..."
   ```

   `setx` writes it for future sessions; a shell you already have open needs
   `$env:ANTHROPIC_API_KEY_WORK = "sk-ant-..."` for the current session, or a fresh
   terminal after `setx`.

2. Reference that OS var's *name* — not its value — in settings:

   ```jsonc
   "marcode.providerInstances": [
     {
       "id": "claude-work",
       "kind": "claude",
       "displayName": "Claude (work)",
       "envMap": {
         "ANTHROPIC_API_KEY": "ANTHROPIC_API_KEY_WORK"
       }
     }
   ]
   ```

3. Reload the window. If the instance doesn't probe successfully, check that the OS var
   is visible to the process VS Code was launched from (`echo $env:ANTHROPIC_API_KEY_WORK`
   in the same shell/session used to launch it).

Allowed `envMap` keys depend on `kind` — see the setting's schema in `package.json` for
the full per-backend list (e.g. `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CONFIG_DIR` for `claude`; `OPENAI_API_KEY`, `CODEX_HOME` for `codex`;
`OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT` for `opencode`).

`envMap` values don't have to be secrets — `CLAUDE_CONFIG_DIR` just points at a directory,
useful for keeping a second account's `claude login` state (credentials, settings) fully
separate from your default one:

```jsonc
"marcode.providerInstances": [
  {
    "id": "claude-personal",
    "kind": "claude",
    "displayName": "Claude (personal)",
    "envMap": {
      "CLAUDE_CONFIG_DIR": "CLAUDE_CONFIG_DIR_PERSONAL"
    }
  }
]
```

with `CLAUDE_CONFIG_DIR_PERSONAL` set (e.g. `setx CLAUDE_CONFIG_DIR_PERSONAL
"C:\Users\you\.claude-personal"`) to an empty folder — run `claude login` once with that
same env var set in the shell to populate it, before starting a session on that instance
from Marcode.

## What v1 does not do

- No plan-usage windows or question-card support for the OpenCode backend — ACP carries
  no plan-usage data, and question cards are out of scope for v1.
- No transcript retention policy — transcripts accumulate under extension storage with
  no automatic pruning.
- No virtualized scrolling in the transcript view.

## Platform note

The Claude Agent SDK ships its native binaries as separate per-platform optional
dependencies, so a `.vsix` only ever carries one platform's copy. The Marketplace release
covers 8 targets — Windows, macOS and Linux (glibc and musl), each x64 and arm64 — built
by CI's per-platform matrix (`.github/workflows/publish.yml`), so `code --install-extension
HiiiiD.mar-code` or an Extensions-view install picks up the right one automatically. A
`.vsix` you build yourself locally (`vsce package` with no `--target`) only ever contains
your own machine's native package, per `.vscodeignore`.
