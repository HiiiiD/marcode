# Marcode host settings

These settings live in `~/.marcode/config.json` (override the directory with `MARCODE_HOME`). Run **Marcode: Open Config File** to edit it. A change takes a window reload. Keys are nested by the dotted id, minus the `marcode.` prefix (for example `memory.enabled` is `{ "memory": { "enabled": true } }`); `codex.path` and `opencode.path` are `codexPath` and `opencodePath`.

## `enabledProviders`

Which agent providers this window registers. A provider left out is not probed and does not appear in the panel. Takes effect after a window reload.

Default: `["claude","codex","opencode"]`

## `providerInstances`

Extra named instances of an existing provider kind — e.g. a second Claude account, or an OpenCode instance pointed at a different config/provider. Non-secret only; secrets stay in OS env vars referenced by `envMap`. Takes effect after a window reload.

Default: `[]`

## `systemPrompts`

Custom system prompt per provider or provider instance, keyed by id (`claude`, `codex`, or an id from `marcode.providerInstances`). A plain string replaces the provider's default prompt outright. Claude also accepts `{"preset": "claude_code"}` (optionally with `append`) to keep Claude Code's own default prompt instead of writing one from scratch. OpenCode has no equivalent wire-level hook and is not a valid key here. Takes effect after a window reload.

Default: `{}`

## `codex.path`

Path to the Codex CLI. Leave empty to use `codex` from PATH.

Default: `""`

## `opencode.path`

Path to the opencode binary. Empty means use opencode from PATH.

Default: `""`

## `usageMirrors`

Copies plan usage from one provider after matching turns in another. Example: ^openai/ usage via Codex, displayed as OpenCode (OpenAI). Takes effect after a window reload.

Default: `[]`

## `shell.aliases`

Names for the shell a `!` command runs through. `!pwsh Get-Date` runs `Get-Date` through the `pwsh` alias; anything else runs in bash. The text after the alias is passed as the last argument. `pwsh` and `powershell` are built in; an entry with the same name replaces one, and `null` removes it. Takes effect after a window reload.

```json
{ "shell": { "aliases": { "zsh": { "command": "zsh", "args": ["-c"] } } } }
```

## `memory.enabled`

Index closed sessions and let agents recall them. Turn off if another memory plugin already does this. Requires a window reload.

Default: `true`

## `memory.summarizer`

How session digests are written. "off" builds them from the transcript with no model call. "llm" runs a hidden agent on session close using the provider, model and effort below. Requires a window reload.

Default: `{"mode":"off"}`

## `review.fileCap`

How many changed files the review tab loads per working tree before showing a "Show more" button. A value over 2000 is clamped; an invalid one falls back to 500. Takes effect after a window reload.

Default: `500`

## `review.pollIntervalMs`

How often, in milliseconds, the review tab re-reads a working tree after it goes dirty. Lower values catch edits sooner at the cost of more frequent git invocations. Takes effect after a window reload.

Default: `750`

## `review.baseRefs`

Extra branch names (e.g. "develop", "trunk") the review tab tries as a working tree's comparison base, after the auto-detected default branch and before the built-in fallbacks (origin/main, origin/master, main, master). Takes effect after a window reload.

Default: `[]`

## `favoriteModels`

Starred model rows, each entry "providerId modelId" (e.g. "opencode gpt-4"). Managed from the New session dialog's star toggle; edit here only to bulk-restore.

Default: `[]`

## `daemon.enabled`

Let the terminal client and the VS Code extension run their host in a per-workspace background daemon so sessions outlive the TUI and a window reload. A change takes a window reload or a restart of the TUI.

Default: `true`

## `daemon.idleMinutes`

Minutes a daemon with no connected client and no running session waits before exiting. A whole number of at least 1. A running daemon keeps the config it started with: the next `marcode` replaces it when it is idle, and otherwise attaches with a warning to run `marcode daemon --stop` once sessions finish.

Default: `10`
