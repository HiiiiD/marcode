# Provider update check

## Problem

Marcode drives three CLI backends (Claude, Codex, opencode) that update independently of
the extension. A session can be running against a stale binary for weeks with no signal —
the user has no reason to check `claude --version` unless something already broke.

## Goal

At activation, tell the user (once per stale version, per provider) that a newer binary is
available. Never auto-update, never block on the check, never persist a claim that could
outlive the install it describes.

## Non-goals

- No auto-update of any binary.
- No manual "check for updates" command (deferred — background-only trigger for v1).
- No badge/chip in the panel UI, no wire message, no `session-patch` involvement.
- No persisted "last notified version" — every activation re-checks and re-notifies if
  still stale. Simpler than tracking dismissal state, and matches how `refreshModels`
  already re-probes every launch rather than trusting a cached verdict.

## Interface

New optional method on `AgentProvider` (`src/providers/types.ts`), alongside `fetchUsage`
and `fetchModels` — same shape: no session, no `cwd`, fire-and-forget from the caller's
point of view, optional because not every provider (`fake`) has a binary to check.

```ts
export interface UpdateInfo {
  current: string;
  latest: string;
}

// on AgentProvider:
/**
 * Compares the locally installed binary against its latest published version.
 * `undefined` means "could not determine" — a parse failure or a network miss
 * is not evidence of staleness, and must never be reported as one. Rejections
 * propagate; the caller treats a throw the same as `undefined`.
 */
checkForUpdate?(): Promise<UpdateInfo | undefined>;
```

Each provider owns its own source and parsing internally — the three backends do not share
a distribution channel, so the method is intentionally opaque above this line.

## Per-provider implementation

| Provider | Local version | Latest source | Parsing |
|---|---|---|---|
| Claude | `claude --version` | `GET https://registry.npmjs.org/@anthropic-ai/claude-code/latest`, `version` field | none |
| Codex | `codex --version` | `GET https://api.github.com/repos/openai/codex/releases/latest`, `tag_name` | strip `rust-v` prefix |
| opencode | `opencode --version` | `GET https://api.github.com/repos/anomalyco/opencode/releases/latest`, `tag_name` | strip `v` prefix |

Verified against the live sources on 2026-09-04:
- `anthropics/claude-code` has no GitHub releases at all — the npm registry is confirmed as
  the actual publish channel (its `version` field matched the repo's `CHANGELOG.md` top
  entry exactly: `2.1.260` both places). Scraping `CHANGELOG.md` was considered and dropped
  in favor of the registry's single JSON field — same source of truth, no markdown parsing.
- `openai/codex` releases use tag format `rust-v0.153.2`.
- `anomalyco/opencode` releases use tag format `v1.18.27`.

Each implementation:
1. Runs the local `--version` command via the same child-process mechanism providers
   already use for probes.
2. Fetches its latest-version source.
3. On any failure — process spawn error, non-2xx response, unparseable version string on
   either side — resolves `undefined` and logs one `console.warn` (the existing
   probe-failure pattern: a developer-facing trace, never a thrown exception, never a
   user-facing error state). A stale-but-undetermined provider is silent, not "up to date".
4. On success, compares semver and resolves `{ current, latest }` only — comparison (is
   `latest` actually newer?) happens at the call site, not here, so the method's contract
   stays "what I found" rather than "what I concluded."

## Trigger

`SessionManager` gets `checkForUpdates(): Promise<{ id: string; displayName: string; info: UpdateInfo }[]>`,
structurally close to `refreshModels`/`refreshUsage` but returns its settled results instead
of emitting them — this is the one place the pattern diverges, because the result's
destination (`vscode.window.showInformationMessage`) lives in `extension.ts`, which is the
only place already importing `vscode` for that purpose; `SessionManager` itself imports no
`vscode` API today and this feature is not reason enough to start:

```ts
async checkForUpdates(): Promise<{ id: string; displayName: string; info: UpdateInfo }[]> {
  const results = await Promise.all([...this.providers.values()]
    .filter((p) => p.checkForUpdate)
    .map((p) => Promise.resolve().then(() => p.checkForUpdate!()).then(
      (info) => info ? { id: p.id, displayName: p.displayName, info } : undefined,
      (err: unknown) => {
        console.warn('[mar-code] session-manager: update check failed for', p.id, err);
        return undefined;
      },
    )));
  return results.filter((r): r is { id: string; displayName: string; info: UpdateInfo } => r !== undefined);
}
```

Wrapped in `Promise.resolve().then()` for the same reason `refreshModels` is: the interface
only promises a `Promise` return, not an `async` function, so a synchronously-throwing
provider (legal against the type) must not throw out of `checkForUpdates`' own body.

Called once from `extension.ts`'s `activate()`, fire-and-forget, alongside the existing
`manager.refreshModels(defaultCwd)` kickoff — not gated on it, not gating anything else:

```ts
void manager.checkForUpdates().then((stale) => {
  for (const { displayName, info } of stale) {
    if (semverGt(info.latest, info.current)) {
      void vscode.window.showInformationMessage(
        `${displayName} ${info.current} → ${info.latest} available.`
      );
    }
  }
});
```

## Surfacing

Purely host-side, no protocol involvement — see the `activate()` snippet above. One
`showInformationMessage` per stale provider (parallel notifications, not batched into one
message) — same call used elsewhere in `activate()` for other one-time notices. No
link/action button in v1; the message names the provider and both versions, and the user
updates through whatever channel they normally use.

## Data flow

```
activate()
  └─ manager.checkForUpdates()          (fire-and-forget, parallel to refreshModels/refreshUsage)
       └─ per provider: checkForUpdate()
            ├─ spawn `<binary> --version`
            ├─ fetch latest-version source
            └─ resolve {current, latest} | undefined
       └─ .then(stale => ...)           (back in extension.ts)
            └─ per stale entry: vscode.window.showInformationMessage(...)
```

No wire message, no `PostBus` involvement, no `ProviderInfo`/`UnavailableProvider` field
change, no `catalog.json` change. This is deliberately the smallest surface that answers
the question — it shares the *shape* of the existing probe methods (optional, provider-
owned, fire-and-forget, errors-as-state) without touching anything the webview reads.

## Testing

- Unit: each provider's `checkForUpdate` against a mocked spawn + mocked fetch — success,
  network failure, unparseable local version, unparseable remote version, remote version
  equal to or older than local (must not report stale).
- Unit: `SessionManager.checkForUpdates` — provider without the method is skipped, a
  rejecting provider does not stop the others, `Promise.all` settles even when every
  provider fails.
- No DOM/webview coverage needed — nothing crosses `postMessage`.
