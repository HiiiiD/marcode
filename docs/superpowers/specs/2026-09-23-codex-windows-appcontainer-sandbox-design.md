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

**Confirmed upstream, not Marcode-specific.** Two things were checked before committing to this
design, both ruling out a smaller fix: (1) codex-cli 0.156.1 already exposes a client-driven Windows
sandbox setup handshake (`windowsSandbox/readiness`, `windowsSandbox/setupStart`,
`windowsSandbox/setupCompleted` — see `codex-rs/app-server-protocol/src/protocol/v2/windows_sandbox.rs`)
built on the same AppContainer-style capability-SID primitive this design independently arrived at.
On this dev machine it already reports `"ready"` with zero setup ever run by any client, yet
`bash -lc "git status"` still fails identically to the documented bug
(`CreateFileMapping ... error 5`) — `"ready"` does not mean the fork-emulation path is fixed, for
reasons not fully understood (possibly a further per-thread `activePermissionProfile` opt-in that
came back `null` and was never exercised). (2) The same repro run against the **official Codex VS
Code extension** (not Marcode) hit the sibling failure mode from the same doc comment —
`Bash/Service/CreateInstance/E_ACCESSDENIED`, `PATH` resolving `bash` to the WSL stub instead of real
Git Bash — while a plain `git status` (no fork) worked, matching Marcode's own behavior exactly. The
bug is general and upstream; neither the existing handshake nor "use the official client's spawn
recipe" is a smaller fix than this design.

Validated by two spikes (see conversation 2026-09-23; scratch code at
`%TEMP%\marcode-appcontainer-spike\Spike.cs`/`SpikeNet.cs`): nested spawn (`cmd.exe` → `git.exe`)
works inside an AppContainer; folder-scoped ACL grant allows reads/writes inside, denies everywhere
else including the process's own scratch directory; profile creation is ~10-19ms (once, cached),
spawn+wait overhead is normal process-cold-start, no admin rights required, no AV interference
observed; outbound network is blocked entirely with zero capabilities (`curl` fails DNS resolution
instantly) but works identically to an unsandboxed process once the well-known `internetClient`
capability (SID `S-1-15-3-1`) is granted.

The second spike also found the write-only model below is not optional, it's necessary: Codex's own
home-directory resolution (`codex login status`, needed before anything else runs) fails with
`Could not find home directory` unless the container can at least see `%USERPROFILE%` — granting
just `%USERPROFILE%\.codex` (where auth and skills live) was not enough, because the failure happens
one level up, before Codex ever opens that folder. The same is true, more broadly, of any interpreter
installed per-user rather than system-wide (`pyenv`/`nvm`-style Python/Node installs under
`%LOCALAPPDATA%`/`%APPDATA%`, global npm packages) — `cmd.exe`/`git.exe` worked untouched in the
first spike only because both happen to live under `Program Files`/`System32`, which Windows already
ACLs for `ALL APPLICATION PACKAGES`; nothing under the user's own profile carries that by default.

## Non-goals

- Not a fork of `codex-cli` or any change to the upstream `codex` binary. Marcode changes only how
  *it* spawns and wires that binary.
- Not a replacement for macOS/Linux sandboxing — Seatbelt/Landlock already work correctly there via
  codex's own `sandbox`/`sandboxPolicy`; this is Windows-only.
- **Not a confidentiality boundary. Deliberately.** The thing this design exists to stop is
  `danger-full-access` letting an agent overwrite or delete anything on the machine — a **write**
  concern, and the one literally raised as the reason to build this. It is not a read/exfiltration
  boundary: `approvalPolicy` (untouched by this design — see below) already gates what an agent
  *does* with anything it reads, on every mode except `bypass`, exactly as it does today without any
  sandbox at all. Building a read boundary too would need blocking `.codex`, every per-user
  interpreter install, and now network — three things a working Codex session cannot function
  without — for a guarantee nothing asked for. See "Write confinement, not filesystem confinement"
  below.
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

### Write confinement, not filesystem confinement

The container's default-deny (verified by the spike against `%TEMP%`, `%USERPROFILE%\Documents`,
and its own scratch directory) applies to both reads and writes. This design only wants the write
half of that:

- **Read+execute is granted broadly** — in practice the whole user profile, so `.codex` (auth,
  skills), per-user interpreter installs, and anything else Codex or a shelled-out tool needs to
  merely open resolves the same as it would unsandboxed. This is what fixes the home-directory
  resolution failure and the PATH-interpreter problem in one move, without enumerating `PATH` or
  reasoning about traverse-vs-read Windows ACL semantics per folder.
- **Write stays scoped to the workspace root(s)** — this is the property that actually matters, and
  the only one this design changes versus today's `danger-full-access`. `plan` mode grants no write
  access anywhere (read+execute only, same as the rest of the profile), so "nothing on disk changes"
  keeps meaning that.
- **The `internetClient` capability (SID `S-1-15-3-1`) is granted by default** — zero capabilities
  blocks all outbound network (DNS resolution itself fails), which would break `git fetch`/`push`,
  `npm install`, and any API call. This is a network-only grant; the spike found no effect on the
  filesystem ACL story from adding it.

An AppContainer profile's ACL grant is set once, at profile-provisioning time, not per spawn. The
provider is process-lifetime, ref-counted across every open Codex thread/session
(`CodexProvider` doc comment, "One process serves every Codex session"), and Marcode does not
know every thread's `cwd` before the first one starts a session. The **write** grant (the only one
that needs to track individual sessions — read is already broad) is therefore:

- Granted eagerly at each thread's `cwd` (existing param already sent to `thread/start`).
- A newly seen `cwd` mid-lifetime gets a write ACL grant added to the *same* container profile
  (ACLs are additive per-folder; no need to recreate the profile or respawn `app-server`).
- Grants are tracked and revoked — see "Grant lifetime" below. An earlier draft of this spec said
  grants were "never revoked while the provider process is alive"; that understated it. An `icacls`
  grant is NTFS metadata keyed to the container SID, so with a fixed container name it outlives the
  process, the VS Code window and reboots, and applies to every window and workspace on the machine.

### Grant lifetime

- **Per-window container name.** The AppContainer profile name is derived from something unique to
  the provider process (`MarcodeCodexSandbox-<uuid>`), so its SID, and every ACE written for it,
  belongs to exactly one window's `app-server`. Per-session scope is not achievable: one
  `app-server` process serves every thread.
- **Every grant is recorded** (folder, mode, scope) in a per-process tracker as it is made.
- **Revoke on dispose.** Teardown runs `icacls <folder> /remove *<SID>` for each recorded grant and
  deletes the profile (`DeleteAppContainerProfile`). A crash skips this, so activation also sweeps
  profiles matching the name prefix whose owning process is gone. An orphaned ACE from a crashed run
  is inert because its unique SID never recurs.
- The baseline workspace-root write grant follows the same rules; it is not a special case.

### Out-of-root writes: ask, then grant

Codex cannot ask about a write outside the workspace: on Windows it is told `dangerFullAccess`, so it
perceives no boundary to cross (see "Where enforcement moves"). Marcode owns the ask instead:

- **Measured (spike, codex-cli 0.156.1, `danger-full-access` + `on-request`):** codex raises no
  `item/*/requestApproval` for an out-of-root `apply_patch`; it writes the file, then emits
  `item/started` (already carrying the resolved absolute path and the diff) and `item/completed`
  about 4ms apart, both *after* the write. Under `workspace-write` the model itself refused before
  patching, so no request was raised there either. A card **before** the write is therefore not
  possible; the flow is reactive:
  1. The write is denied by the container. Codex reports the `fileChange` item as failed, naming
     the path in `changes[].path`. (What a container-denied item looks like on the wire is verified
     in Task 8's first step, not assumed.)
  2. Marcode recognises a failed `fileChange` whose path lies outside every granted write root and
     raises its approval card.
  3. On approval it grants the path's containing folder to the window's container SID, then sends
     the agent a follow-up message that access was granted so it retries. Cost: one failed attempt
     and one extra turn, and the agent may not retry exactly what the user approved.
- **v1 ships allow / deny only, meaning "this session".** `ToolDecision` carries no scope today, so
  the fuller card below needs a protocol change and a UI pass and is a later task.
- The full card offers three scopes:
  - **Once:** grant, let the tool call run, revoke when it completes.
  - **This session:** recorded in the tracker, revoked on dispose (same lifetime as the baseline).
  - **Always for this folder:** the only scope that persists; chosen explicitly by the user, and
    recorded in Marcode's own state so it can be listed and removed. It is re-applied to the
    per-window SID at each activation, never left on disk under an old one.
- **Limit, stated once:** this only works where Marcode knows the target path before execution.
  An opaque shell command (`npm install -g`, a script writing somewhere unpredictable) cannot be
  pre-approved; it fails with access denied and offers no retry.

### Accepted tradeoff

Because read is broad and network is enabled, a compromised or malicious agent run could still
*read* something sensitive elsewhere in the profile (SSH keys, browser data, other repos) and
*exfiltrate* it over the network, even though it cannot overwrite or delete any of it. This is not a
new exposure — `danger-full-access` has neither restriction either — and the existing control on
what an agent actually does with a read is unchanged: `approvalPolicy`, live on every mode except
`bypass`. It is named here once, deliberately, rather than left implicit.

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
- `grants.ts` — the per-process grant tracker: records each grant, exposes `revokeAll()` for dispose
  and `revoke(folder)` for the "once" scope, and owns the startup sweep of stale profiles.
- `acl.ts` — grants an AppContainer SID access to a folder (`icacls <path> /grant "*<SID>:(OI)(CI)<perm>"`,
  `(OI)(CI)F` for a workspace-write root, `(OI)(CI)RX` for the broad profile-wide read grant and for
  `plan` mode's write-free sessions), verified by the spike to need no elevation on a user-owned
  folder.

## Testing

- Unit (win32-only gate, mirrors `src/test/unit/codex-gate.ts`'s pattern of skipping when the real
  binary/platform isn't present): profile SID derivation is idempotent (create-or-derive), a write
  ACL grant on a temp folder allows read/write inside and denies *write* outside (read outside is
  expected to succeed once the profile-wide read grant lands), nested spawn (`cmd.exe` → a real
  child) succeeds inside the container, outbound network succeeds once `internetClient` is granted
  and fails without it.
- Grant tracker (`grants.ts`): every grant is recorded; `revokeAll()` issues one `/remove` per
  recorded folder and deletes the profile; the "once" scope revokes exactly one folder; the startup
  sweep removes stale profiles whose owning process is gone and leaves live ones alone.
- `sandboxPolicyOf` unit tests (`src/test/unit/codex-map-settings.test.ts`) gain a platform-branch
  case: on a mocked win32 platform, every `PermissionMode` maps to `dangerFullAccess`.
- `codex-provider.test.ts`: `spawnAppServer`'s injected `spawn` seam already exists
  (`opts.spawn`); a win32-path test asserts `windows-sandbox`'s `spawnSandboxed` is invoked in place
  of the plain `child_process.spawn` path, via the same injection point.
- No DOM/UI surface — this is host-only, nothing crosses `postMessage`.

## Out of scope

- Any capability scoping beyond the single `internetClient` grant — no per-domain network
  allowlist, no registry/device isolation. `networkAccess` keeps meaning what it means today.
- A settings UI toggle. Ships as the win32 default behavior of `CodexProvider`, same as
  `sandboxPolicyOf` is not user-configurable today.
- Extending this to the `opencode`/ACP or Claude providers. Codex is the only provider whose own
  Windows sandboxing is broken; the others don't send a `sandbox` policy over their wire protocols
  in the first place.
- A read/confidentiality boundary — see "Non-goals" above. Not a deferred feature; a deliberate
  non-target of this design.
