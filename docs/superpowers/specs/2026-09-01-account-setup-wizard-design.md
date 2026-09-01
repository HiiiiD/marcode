# Account-setup wizard: guided provider-instance creation with skill/plugin copy

## Problem

`marcode.providerInstances` (README, "Provider instances: setting secrets") lets a user
run a second Claude account, a Codex instance against a different `CODEX_HOME`, or an
OpenCode instance against a different config — but setting one up today is entirely
manual: hand-edit `settings.json`, remember the allowed `envMap` keys per `kind`, run
`setx`, run the backend's own login once with that env var set. There is no guided path,
and a fresh instance starts with none of the skills/plugins the user's main account
already has, because it points at an empty config dir by design (that's the isolation
`CLAUDE_CONFIG_DIR`/`CODEX_HOME` buys).

The ask: help a user create one of these secondary accounts, and carry over the
skills/plugins they're used to from their main account — without turning this into
cross-provider migration (Claude → Codex). Same kind in, same kind out; only the config
dir changes.

## Non-goals

- Cross-provider skill translation (Claude ↔ Codex ↔ OpenCode). Out of scope entirely —
  this feature only clones a second instance of the *same* kind.
- Running `setx` or the backend's login command on the user's behalf. Marcode does not
  manage authentication (README, "Requirements") except the existing one-click reauth for
  an *expired* login; creating a *new* one stays a manual step the wizard tells the user
  to do, same as the README's existing worked example.
- Editing or removing existing `providerInstances` entries through the wizard — v1 only
  adds one.
- OpenCode support for the copy step (see below) — its skill/plugin directory layout
  isn't confirmed the way Claude's and Codex's are.

## Command: `Marcode: Set up a provider account`

A native VS Code multi-step `QuickPick`/`InputBox` sequence (same idiom as the existing
`Marcode: Sign in to Claude`/`Sign in to Codex` commands — no new webview, no new bundle).

Steps:

1. **Kind** — QuickPick over `claude` / `codex` / `opencode`.
2. **Identity** — instance `id` and `displayName` (`InputBox`, validated non-empty,
   `id` checked for collision against existing `marcode.providerInstances` entries).
3. **envMap keys** — QuickPick (multi-select) over that `kind`'s allowed `envMap` keys,
   the same per-kind list already documented in README / `package.json`'s setting schema
   (e.g. `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
   `CLAUDE_CONFIG_DIR` for `claude`; `OPENAI_API_KEY`, `CODEX_HOME` for `codex`;
   `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT` for `opencode`).
4. **OS env var names** — for each selected key, an `InputBox` asking which *OS*
   environment variable name to map it to (not its value — the wizard never reads or
   writes a secret, matching the existing invariant that `providerInstances` holds no
   secrets itself).
5. **Copy skills/plugins from your main account?** (`claude`/`codex` only — this step is
   skipped entirely for `opencode`, see Non-goals). If the instance mapped a config-dir
   key (`CLAUDE_CONFIG_DIR` for `claude`, `CODEX_HOME` for `codex`) and the user confirms:
   - Resolve **source**: the OS env var of the same name already set for the *main*
     account, if any (`CLAUDE_CONFIG_DIR`/`CODEX_HOME`), else the platform default
     (`~/.claude` or `~/.codex`).
   - Resolve **target**: the directory named by the OS env var the user is about to set
     for the new instance (from step 4).
   - Copy `skills/` and `plugins/` only, recursively, source → target, skipping either
     subdirectory if it doesn't exist at the source. Nothing else under the config dir is
     touched — not `auth.json`/credentials, not `config.toml`/`settings.json`, not
     `sessions`/`history`. This is a plain `fs.cp(..., { recursive: true })` per
     subdirectory; the target is a directory the wizard itself is about to point a brand
     new instance at, so there's no merge case to handle.
   - Runs synchronously as part of finishing the wizard, before the settings write; a
     copy failure (e.g. source doesn't exist) is a warning, not a hard stop — the instance
     can still be created without it.
6. **Show the setx command(s)** for every OS var chosen in step 4, and remind the user to
   run the backend's own login once with those vars set in the shell (`claude login`,
   `codex login`, etc.) before starting a session on the new instance.
7. **Write** the new entry into **user** `settings.json`'s `marcode.providerInstances` via
   `vscode.workspace.getConfiguration().update(..., ConfigurationTarget.Global)`. User
   scope, not workspace — an OS-level account/env-var is machine-wide, matching how the
   `setx` step itself is machine-wide.
8. **Reload prompt** — an information message with a **Reload Window** action, since
   `providerInstances` changes only take effect at `activate()` (same invariant as
   `enabledProviders`).

## Code shape

- New file `src/host/account-setup-wizard.ts` — host-only (like `panel-view-provider.ts`),
  free to import `vscode`. Registers the command in `extension.ts` next to the existing
  sign-in commands.
- The pure parts — validating an `id` doesn't collide, building the
  `ProviderInstanceConfig` object from collected answers, and the skills/plugins copy
  function (`copySkillsAndPlugins(sourceDir, targetDir): Promise<{copied: string[]}>`) —
  are extracted as standalone functions so they unit-test without a `vscode` import,
  matching the existing pattern (`message-router.ts`, `claim-paths.ts`).
- Per-kind allowed `envMap` keys and config-dir key name (`CLAUDE_CONFIG_DIR` /
  `CODEX_HOME`) are read from the same source `package.json`'s setting schema already
  encodes — no second hardcoded list to drift from README's.

## Error handling

- Duplicate `id` — caught before the settings write, `InputBox` validation message,
  step re-asked.
- `settings.json` write failure (e.g. read-only) — `vscode.window.showErrorMessage`, no
  partial state (`update()` is atomic; the copy step, if it ran, already happened to disk
  independent of the settings write — a copy that succeeded but a settings write that
  failed leaves usable files sitting in an unreferenced dir, not a leak worth guarding
  further).
- Skills/plugins copy failure — warning message, wizard continues to the settings write;
  never blocks instance creation.

## Testing

- Unit tests (mocha, no `vscode`) for: `id` collision validation, the
  `ProviderInstanceConfig` builder from answers, and `copySkillsAndPlugins` (using a temp
  dir fixture — source with `skills/`+`plugins/`+other files, assert only the two
  subdirectories land in target).
- Integration smoke test (`@vscode/test-cli`) that the command registers, matching however
  the existing sign-in commands are (or aren't) covered today.

## Open question for the implementation plan

None outstanding — kind scope (`claude`+`codex`), copy contents (`skills/`+`plugins/`
only), settings target (user scope), and reload handling (explicit action) are all
resolved above.
