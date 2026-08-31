# Provider instances — design

## Problem

`AgentProvider`s are keyed 1:1 by kind string (`claude` | `codex` | `opencode` | `fake`),
constructed once each in `extension.ts` from `marcode.enabledProviders`. There is no way to
run two differently-configured instances of the same backend at once — e.g. a personal
Claude account alongside a work one with its own `ANTHROPIC_BASE_URL`/API key, or an
OpenCode instance whose own config points at a different model provider (Grok, etc.).

Neither `ClaudeProvider` nor the ACP spawn recipes (`codex`, `opencode`) accept any
env/baseURL override today — auth is entirely delegated to each backend's own CLI/SDK
mechanism, and the only per-provider setting is a single binary path
(`marcode.codex.path`, `marcode.opencode.path`).

## Non-goals

- No generic "spawn any ACP binary" provider kind. A new vendor (e.g. Grok) is reached by
  configuring an existing kind's own multi-provider support (OpenCode already routes to
  many model backends via its own config), not by Marcode learning a new spawn recipe.
- No in-panel settings UI. Configuration lives in VS Code `settings.json`, same as every
  other Marcode setting today.
- No secrets in `settings.json`. Secret values live in OS environment variables only;
  settings reference them by name.

## Data model

New setting `marcode.providerInstances`: array of extra named instances of an *existing*
kind, additive to the base instances `enabledProviders` already constructs.

```jsonc
{
  "id": "claude-work",          // unique, distinct from base kind ids (claude/codex/opencode/fake)
  "kind": "claude",             // "claude" | "codex" | "opencode"
  "displayName": "Claude (work)",
  "binPath": "",                // optional: pathToClaudeCodeExecutable (claude) / CLI path (codex, opencode)
  "envMap": {                   // subprocess env var name -> OS env var name to read the value from
    "ANTHROPIC_BASE_URL": "WORK_ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY": "WORK_ANTHROPIC_API_KEY"
  }
}
```

`envMap` is name→name indirection, not literal values: two instances of the same kind both
need e.g. `ANTHROPIC_API_KEY`, but the OS has only one variable of that literal name, so
each instance points at its own OS variable. Values are resolved from `process.env` at
provider construction time (extension activation); a missing OS variable is not a
config-time error — it surfaces later as a normal auth failure.

Claude does not require an API key: the SDK also honors `CLAUDE_CONFIG_DIR` (where the
`claude` CLI stores its own OAuth session) and `pathToClaudeCodeExecutable` (a different
Claude Code binary/install). A second Claude *subscription* is `envMap.CLAUDE_CONFIG_DIR`
pointed at its own directory plus a one-time `claude auth login` there — no API key
involved at all.

### Settings schema / intellisense

`envMap` gets per-`kind` property suggestions via JSON Schema `if`/`then` on the sibling
`kind` field, with `additionalProperties: true` so anything not enumerated still validates:

- **claude**: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CONFIG_DIR`
- **codex**: `OPENAI_API_KEY`, `CODEX_HOME` (confirmed against `openai/codex` docs:
  `CODEX_HOME` holds `auth.json`, defaults `~/.codex`). No `OPENAI_BASE_URL` — Codex
  configures providers via `config.toml`'s `model_providers`, not a plain env var; base-URL
  override for a codex instance is out of scope for this design (see Open items).
- **opencode**: `OPENCODE_CONFIG` (custom config file path), `OPENCODE_CONFIG_DIR` (custom
  config dir, same layout as `.opencode`), `OPENCODE_CONFIG_CONTENT` (inline config,
  highest precedence) — confirmed against the OpenCode docs. This is the lever for
  "OpenCode instance pointed at Grok": point `OPENCODE_CONFIG`/`_DIR` at a profile whose own
  `opencode.json` selects a different model provider.

`KNOWN_PROVIDER_IDS` / `marcode.enabledProviders` are unchanged — they govern the four base
kinds. `providerInstances` is purely additive.

## Provider construction

In `extension.ts` `activate()`, after the existing base-provider loop: read
`marcode.providerInstances`, validate each entry (`kind` known, `id` unique, `id` not
colliding with a base kind id) — an invalid entry gets `showWarningMessage` and is skipped,
mirroring the existing unknown-`enabledProviders`-id handling. For each valid entry:

1. Resolve `envMap` against `process.env` into a concrete `Record<string,string>`.
2. Construct the provider class for `kind`, passing `id`, `displayName`, the resolved env,
   and `binPath`:
   - **claude**: `ClaudeProvider` gains ctor params for `id`/`displayName` (always passed —
     the base `claude` instance now passes `{id:'claude', displayName:'Claude'}` explicitly
     instead of a hardcoded literal) and `env`/`pathToClaudeCodeExecutable`, merged into the
     SDK `Options` as `{ ...process.env, ...instanceEnv }` (the SDK does **not** merge `env`
     with `process.env` itself — must be spread manually) and `pathToClaudeCodeExecutable`
     respectively.
   - **codex** / **opencode**: same shape. Their spawn functions
     (`spawnAppServer`/`spawnOpenCodeAcp`) already accept/need an `env` param (Codex already
     merges one in for the self-control token) — extend to
     `{...process.env, ...instanceEnv, ...selfControlEnv}`.
3. Register in `SessionManager`'s `providers` Map keyed by `id` — no `SessionManager` change
   needed, the map is already keyed by an arbitrary string.
4. Record `{command, env: instanceEnv}` in the login-command table (see below), keyed by
   `id`.

`AgentProvider.id`/`.displayName` were already `readonly` instance fields, not per-class
constants, so making them ctor-supplied is not an interface change.

## Login and auth-failure UX

Two distinct auth shapes exist per instance, and the login card must tell them apart:

- **Claude, OAuth/CLI-session** (`envMap` has no key-shaped variable — e.g. only
  `CLAUDE_CONFIG_DIR`, or nothing): login is `claude auth login` run in a terminal.
- **Claude, API-key instance** (`envMap` sets `ANTHROPIC_API_KEY` directly): no login flow
  exists — a terminal running `claude auth login` would write an OAuth session nobody reads
  and would not fix the actual problem (a missing/bad OS env var). The failure card must not
  offer a Login button for these; it shows the reason text only.
- **Codex, always terminal-login, command depends on `envMap`**: unlike Claude, an
  `OPENAI_API_KEY` in `envMap` doesn't make codex key-based-with-no-login — the key still
  has to be persisted into that instance's `CODEX_HOME/auth.json` via a login command,
  just a different one: `printenv OPENAI_API_KEY | codex login --with-api-key` (piped, using
  the resolved value) instead of plain `codex login` (browser OAuth) when no key is set.
  Both are scoped to the instance's `CODEX_HOME`.

`LOGIN_COMMANDS` (today `kind → command`, static) becomes an `instanceId → {command, env}`
table built alongside the providers map, where `command` for codex is chosen per-instance
(with-api-key vs plain) from whether its resolved `envMap` has `OPENAI_API_KEY`.
`openLoginTerminal` gains an `env` param (VS Code `createTerminal` already supports one) so
the terminal's session lands in *this instance's* config dir
(`CLAUDE_CONFIG_DIR`/`CODEX_HOME`), not the default one.

This means the webview's `isSignInFailure` regex heuristic is no longer sufficient on its
own to decide whether to render the Login button. Catalog/`unavailable()` payloads gain a
per-instance `loginKind: 'oauth' | 'none'` — `'none'` only for a Claude API-key instance,
`'oauth'` for everything else including every codex instance — computed once at
construction and threaded to `pane-group.tsx` / `transcript-item.tsx` to gate the button.
Base (non-custom) `claude`/`codex` instances keep `loginKind: 'oauth'`, unchanged behavior.

## UI

No new screens. Extra instances surface exactly like existing providers — catalog entries
render generically by `id`/`displayName`, so they simply appear as more roster/model-picker
options. The existing "open settings" deep-link button (`pane-group.tsx`) is pointed at
`marcode.providerInstances` in addition to `marcode.enabledProviders`.

## Testing

- Unit: `providerInstances` validation (unknown kind, duplicate/colliding id → warning +
  skip), as a pure function extractable without a `vscode` import, mirroring
  `enabledProviderIds()`'s existing pattern.
- Unit: `ClaudeProvider`/`CodexProvider`/`OpenCodeProvider` env-merge — construct with an
  `env` override, assert the resulting `Options.env` / spawn `env` contains
  `{...process.env, ...override}`.
- Unit: `loginKind` computation — key-shaped `envMap` entry → `'none'`; otherwise `'oauth'`.
- DOM: `pane-group.tsx` / `transcript-item.tsx` — Login button absent when
  `loginKind: 'none'`, present and posts the correct instance id when `'oauth'`.
- Integration: skipped, no real second account available in CI — same reasoning as the
  existing `codex-gate` skip pattern.

## Open items before implementation

- Codex base-URL override (a codex instance pointed at a non-OpenAI-compatible proxy) is
  out of scope here — no env var for it, only `config.toml`'s `model_providers`. If needed
  later, the lever is `binPath` pointing at a wrapper that writes/selects a `config.toml`
  before exec, not `envMap`.
