# Codex Windows sandbox via AppContainer

## Goal

On Windows, Codex's own sandbox (`workspace-write`/`read-only`, sent as `sandbox`/`sandboxPolicy`
on the wire) breaks any command the `app-server` process shells out to that itself spawns a further
child — `git`, Git Bash/Cygwin (`CreateFileMapping` ACCESS_DENIED), WSL's `bash.exe` stub
(`E_ACCESSDENIED` talking to LxssManager) — because codex's restricted token blocks further process
creation outright (see `map-settings.ts:68-88`, the existing doc comment). The only sandboxed-adjacent
Windows workaround today is `bypass` (`danger-full-access`): no sandbox, no prompts, unrestricted
filesystem access. That is an unacceptable default and not something Marcode should tell every
Windows user is the only way to get a working `git switch`.

Replace codex's own (broken) Windows sandbox enforcement with one Marcode controls: run the
`app-server` process itself inside a Windows **AppContainer** — a low-privilege container token
(the primitive UWP apps use) — scoped by filesystem ACL to the session's writable roots. Unlike
codex's restricted token, an AppContainer token does not block further child-process creation, so
`git`/bash chains work; unlike `danger-full-access`, everything outside the granted roots is denied
at the OS level regardless of what the agent tries to run.

Validated by spike (`docs/superpowers/specs/` — see conversation 2026-09-23; scratch code at
`%TEMP%\marcode-appcontainer-spike\Spike.cs`): nested spawn (`cmd.exe` → `git.exe`) works inside an
AppContainer; folder-scoped ACL grant allows reads/writes inside, denies everywhere else including
the process's own scratch directory; profile creation is ~10-19ms (once, cached), spawn+wait
overhead is normal process-cold-start, no admin rights required, no AV interference observed.

## Non-goals

- Not a fork of `codex-cli` or any change to the upstream `codex` binary. Marcode changes only how
  *it* spawns and wires that binary.
- Not a replacement for macOS/Linux sandboxing — Seatbelt/Landlock already work correctly there via
  codex's own `sandbox`/`sandboxPolicy`; this is Windows-only.
- Not full container-grade isolation (no network capability scoping beyond what `networkAccess`
  already expresses, no registry/device isolation). Scope is filesystem: the one thing
  `danger-full-access` currently leaves fully exposed.
- No visible windows. The spike's `CREATE_NEW_CONSOLE` flag is explicitly **not** carried into the
  real implementation — see the windowsHide bug this design supersedes
  (`codex-provider.ts` `spawnAppServer`, fixed on `fix/fix-windows-hide-on-codex` to at least stop
  the *unsandboxed* spawn from flashing a console; the sandboxed spawn must never regress that).

## Design

### Where enforcement moves

Today, `CodexProvider.spawnAppServer` (`src/providers/codex/codex-provider.ts:77`) spawns one
`app-server` process per provider instance via plain `child_process.spawn`, and `sandboxPolicyOf`
(`src/providers/codex/map-settings.ts:90`) tells that process, over the wire, which of codex's own
(OS-native) sandboxes to self-apply per thread/turn.

On win32, this changes to:

- `spawnAppServer` on win32 launches the `app-server` binary **inside an AppContainer**, ACL-scoped
  to the union of writable roots the active/soon-to-be-active threads need (the workspace folder(s)
  Marcode already knows — see "Writable roots" below). This is the new enforcement layer.
- `sandboxPolicyOf` on win32 always returns `{ type: 'dangerFullAccess' }`, regardless of
  `PermissionMode` — codex's own sandboxing is redundant (and broken) once the whole process tree
  already runs inside an OS-enforced container. `PermissionMode`'s `approvalPolicy` and
  `approvalsReviewer` axes are untouched; only the `sandbox` axis is short-circuited on this
  platform. `plan` mode (`read-only`) still maps to a **read-only** ACL grant on the container
  instead of a writable one, so "nothing on disk changes" keeps meaning that.
- macOS/Linux: no change. `sandboxPolicyOf` and `spawnAppServer` keep their current behavior.

### Writable roots

An AppContainer profile's ACL grant is set once, at profile-provisioning time, not per spawn. The
provider is process-lifetime, ref-counted across every open Codex thread/session
(`CodexProvider` doc comment, "One process serves every Codex session"), and Marcode does not
know every thread's `cwd` before the first one starts a session. Root set is therefore:

- Granted eagerly at each thread's `cwd` (existing param already sent to `thread/start`).
- A newly seen `cwd` mid-lifetime gets an ACL grant added to the *same* container profile (ACLs are
  additive per-folder; no need to recreate the profile or respawn `app-server`).
- Grants are never revoked while the provider process is alive — a stale grant on a closed
  session's folder is a narrower, session-scoped version of the risk `danger-full-access` already
  accepts wholesale today, not a new one.

### Fallback

AppContainer provisioning can fail (`CreateAppContainerProfile`/ACL grant erroring — e.g. a locked-
down enterprise policy). Per the "which providers exist is a setting; whether they work is a probe"
invariant, this is a **probe failure**, not a silent downgrade to `danger-full-access`: `start()`
surfaces it the same way a spawn/handshake failure already does (`connectionPromise` cleared, error
propagated to the session as an `error`-status transcript item — no new state machine). No fallback
to unsandboxed spawn happens automatically; a user who wants Codex on that install falls back to
`bypass` mode themselves, same as today, with full knowledge of what that means.

### New files

`src/providers/codex/windows-sandbox/` (folder — this is a service plus its own private helpers,
per the file-size convention):

- `index.ts` — the public seam: `spawnSandboxed(bin, args, cwd, env) => Duplex` (same return shape
  `spawnAppServer` already produces) and `grantRoot(cwd)` for the mid-lifetime case. The only file
  `codex-provider.ts` imports from this folder.
- `helper-source.ts` — the C# source (a template string) for the compiled helper process. AppContainer
  creation/token derivation/`CreateProcess`-with-`SECURITY_CAPABILITIES` has no Node-native
  equivalent without a native addon dependency; a small compiled helper invoked as a subprocess,
  built once from source already checked into the repo, keeps this dependency-free. Adapted from
  the verified spike (`%TEMP%\marcode-appcontainer-spike\Spike.cs`), with two changes: stdio is
  wired through **inherited pipe handles** (not files — `app-server` needs a live bidirectional
  JSON-RPC stream, the spike used files because "did it work at all" didn't need one), and
  `CREATE_NEW_CONSOLE` is dropped in favor of `CREATE_NO_WINDOW` (the spike's flag is exactly the
  focus-stealing bug already fixed for the unsandboxed path).
- `build-helper.ts` — compiles `helper-source.ts` to an `.exe` via the OS-bundled
  `csc.exe` (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, present on every supported
  Windows/.NET Framework install, verified by the spike), caching the binary under
  `context.globalStorageUri` so it compiles once per Marcode install, not once per window.
- `acl.ts` — grants an AppContainer SID access to a folder (`icacls <path> /grant "*<SID>:(OI)(CI)<perm>"`,
  `(OI)(CI)F` for workspace-write roots, `(OI)(CI)RX` for `plan` mode's read-only grant), verified
  by the spike to need no elevation on a user-owned folder.

## Testing

- Unit (win32-only gate, mirrors `src/test/unit/codex-gate.ts`'s pattern of skipping when the real
  binary/platform isn't present): profile SID derivation is idempotent (create-or-derive), ACL grant
  on a temp folder allows read/write inside and denies outside, nested spawn (`cmd.exe` → a real
  child) succeeds inside the container.
- `sandboxPolicyOf` unit tests (`src/test/unit/codex-map-settings.test.ts`) gain a platform-branch
  case: on a mocked win32 platform, every `PermissionMode` maps to `dangerFullAccess`.
- `codex-provider.test.ts`: `spawnAppServer`'s injected `spawn` seam already exists
  (`opts.spawn`); a win32-path test asserts `windows-sandbox`'s `spawnSandboxed` is invoked in place
  of the plain `child_process.spawn` path, via the same injection point.
- No DOM/UI surface — this is host-only, nothing crosses `postMessage`.

## Out of scope

- Network capability scoping (AppContainer capability SIDs beyond the default "no extra
  capabilities" the spike used) — `networkAccess` keeps meaning what it means today.
- A settings UI toggle. Ships as the win32 default behavior of `CodexProvider`, same as
  `sandboxPolicyOf` is not user-configurable today.
- Extending this to the `opencode`/ACP or Claude providers. Codex is the only provider whose own
  Windows sandboxing is broken; the others don't send a `sandbox` policy over their wire protocols
  in the first place.
