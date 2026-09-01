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

## Amendment: config-dir key is a path, not a secret

Post-implementation feedback: `CLAUDE_CONFIG_DIR`/`CODEX_HOME` are plain directory paths,
not credentials, so routing them through the same "invent an OS var name, `setx` it,
restart VS Code" ceremony as `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is friction the value
doesn't warrant. Every other `envMap` key stays OS-var-name-only — this amendment is
scoped to the config-dir key alone.

Revised step 4/5 for that one key: the wizard asks for the **literal directory path**
directly, instead of an OS var name. It then derives a deterministic OS var name from the
key and the instance id (`deriveConfigDirVarName`, e.g. `CLAUDE_CONFIG_DIR_CLAUDE_PERSONAL`)
so `envMap`'s on-disk shape is unchanged — still `subprocess-var -> OS-var-name`, `resolveEnvMap`
untouched. On Windows, the wizard runs `setx <derived-var> "<path>"` in an opened terminal
on the user's behalf (matching the existing `openLoginTerminal` precedent for login flows);
on POSIX there's no unattended equivalent (`terminal.sendText('export ...')` only affects
that one terminal session, not future shells), so it stays a manual `export`/profile-edit
instruction, same as every other manual env var.

Because the wizard now holds the literal target path from the moment it's typed, the
copy step no longer needs to read `process.env[configDirOsVar]` (which was usually still
unset in-process, since `setx`/`export` only take effect for new shells) — it uses the
typed path directly. This removes the "not set yet, skipped" warning for the common case.

`src/shared/account-setup.ts` gains `deriveConfigDirVarName(key, id): string`, unit
tested. `src/host/account-setup-wizard.ts` gains `openSetxTerminal(varName, value): void`
(Windows-only), and `maybeCopySkillsAndPlugins` takes the literal `targetDir` directly
rather than resolving it from `envMap`/`process.env`.

**Follow-up hardening (same review pass):** two gaps surfaced once this path became
user-typed and machine-interpolated rather than sourced from an OS env var the user set up
themselves:

- The path is embedded into a `setx` command sent to a real terminal (`terminal.sendText`),
  so an unquoted shell metacharacter or a trailing slash/backslash (which escapes the
  command's closing quote) in the typed path breaks or misdirects the command. The
  InputBox's `validateInput` now rejects `" \` $ & | ^ < >`, requires `path.isAbsolute`,
  and rejects a trailing `/`/`\`.
- Sanitizing an id for a var name is lossy — `claude-work` and `Claude Work` derive the
  same base name. Two already-distinct instance ids could silently share one OS var (and
  therefore one config dir) at runtime. `deriveConfigDirVarName` stays a pure derivation;
  a new `resolveUniqueConfigDirVarName(key, id, usedVarNames)` appends `_2`, `_3`, ... until
  the name is free of every OS var name already claimed by an existing instance's `envMap`,
  and the wizard calls this instead of the raw deriver.
