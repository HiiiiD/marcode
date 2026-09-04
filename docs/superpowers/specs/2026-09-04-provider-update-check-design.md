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
4. On success, resolves `{ current, latest }` only — comparison (is `latest` actually
   newer?) happens at the call site via `isNewer(latest, current)`, a shared pure function
   (see below), not inside `checkForUpdate` itself, so the method's contract stays "what I
   found" rather than "what I concluded."

## Shared helper module

`src/providers/update-check.ts` — the one place all three providers' `checkForUpdate`
implementations pull from, so the child-process/network mechanics and the version-comparison
logic exist once. Everything here is a pure function or takes its side effect
(`execFile`/`fetch`) as an injectable parameter defaulting to the real implementation — the
same shape `spawn` takes on `OpenCodeProvider`/`CodexProvider` today, and for the same
reason: tests inject a fake, production gets the default.

```ts
export interface UpdateInfo { current: string; latest: string; }

export type ExecVersionFn = (bin: string, args: string[]) => Promise<{ stdout: string }>;
export type FetchFn = typeof fetch;

/** First `x.y.z` substring found, or undefined. Both `--version` output and a
 *  GitHub tag_name can carry a leading name/prefix this strips implicitly. */
export function extractVersion(text: string): string | undefined;

/** Dotted-numeric compare. True when `latest` is strictly newer than `current`.
 *  Malformed input on either side returns false — never a false "update available". */
export function isNewer(latest: string, current: string): boolean;

/** Runs `<bin> --version`(or the given args) via `execVersionFn`, extracts a version.
 *  Resolves undefined on any spawn failure or unparseable output — never rejects. */
export function localVersion(
  bin: string, args?: string[], execVersionFn?: ExecVersionFn,
): Promise<string | undefined>;

/** `GET https://registry.npmjs.org/<pkg>/latest`, reads `.version`.
 *  Resolves undefined on any fetch failure or missing field — never rejects. */
export function npmLatestVersion(pkg: string, fetchFn?: FetchFn): Promise<string | undefined>;

/** `GET https://api.github.com/repos/<repo>/releases/latest`, reads `.tag_name`,
 *  strips `tagPrefix` if present. Resolves undefined on any fetch failure,
 *  missing field, or a non-2xx response — never rejects. */
export function githubLatestVersion(
  repo: string, tagPrefix: string, fetchFn?: FetchFn,
): Promise<string | undefined>;
```

`isNewer` is exported for reuse at the `MessageRouter` call site too (see Surfacing below) —
one comparison function, not a duplicate in the host layer.

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

Called from `MessageRouter`'s `hydrate` handling (the `case 'ready'` branch in
`src/host/message-router.ts`), fire-and-forget, right alongside the existing
`void this.manager.refreshModels(this.defaultCwd)` / `refreshUsage` kickoff — **not**
from `extension.ts activate()`. `refreshModels`/`refreshUsage` are not actually kicked off
at activation; they fire when the webview sends `ready` (panel opened), and this reuses
that exact moment rather than inventing a second one. "Every window/panel open, not every
extension activation" is a difference that only matters for a workspace where the panel is
opened more than once per VS Code session — each `ready` re-runs the check, same as it
re-runs `refreshModels`.

`message-router.ts` may not import `vscode` (hard project invariant — it is what keeps this
file unit-testable outside the extension host), so the toast cannot be issued from inside
the `ready` handler directly. This follows the same pattern already used for
`EditorContextHost`/`ConfigHost`: a small host interface, injected via the constructor,
with a no-op default so existing tests need no change.

```ts
// src/host/message-router.ts
export interface UpdateNotifyHost {
  notify(displayName: string, current: string, latest: string): void;
}
export const NO_UPDATE_NOTIFY: UpdateNotifyHost = { notify: () => {} };

// constructor gains: private readonly updateNotify: UpdateNotifyHost = NO_UPDATE_NOTIFY,

// inside case 'ready', alongside the existing two refresh calls:
void this.manager.checkForUpdates().then((stale) => {
  for (const { displayName, info } of stale) {
    if (isNewer(info.latest, info.current)) {
      this.updateNotify.notify(displayName, info.current, info.latest);
    }
  }
});
```

```ts
// extension.ts — the real implementation, constructed at activate() and passed
// into `new MessageRouter(...)` alongside the existing `editor`/`configHost` adapters
const updateNotify: UpdateNotifyHost = {
  notify: (displayName, current, latest) => {
    void vscode.window.showInformationMessage(`${displayName} ${current} → ${latest} available.`);
  },
};
```

## Surfacing

Purely host-side, no protocol involvement — see the `UpdateNotifyHost` snippet above. One
`showInformationMessage` per stale provider (parallel notifications, not batched into one
message) — same call used elsewhere in `extension.ts` for other one-time notices. No
link/action button in v1; the message names the provider and both versions, and the user
updates through whatever channel they normally use.

## Data flow

```
MessageRouter, case 'ready' (webview hydrate)
  └─ manager.checkForUpdates()          (fire-and-forget, parallel to refreshModels/refreshUsage)
       └─ per provider: checkForUpdate()
            ├─ run `<binary> --version`
            ├─ fetch latest-version source
            └─ resolve {current, latest} | undefined
       └─ .then(stale => ...)           (back in MessageRouter)
            └─ per stale entry, isNewer(latest, current) → this.updateNotify.notify(...)
                 └─ extension.ts's UpdateNotifyHost → vscode.window.showInformationMessage(...)
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
