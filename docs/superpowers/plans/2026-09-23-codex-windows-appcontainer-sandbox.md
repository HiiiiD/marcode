# Codex Windows AppContainer Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Codex's own broken Windows sandbox (`workspace-write`/`read-only`, which blocks
any shelled-out child process from spawning a further child — confirmed upstream, not a Marcode
misconfiguration: codex-cli's own `windowsSandbox/readiness` handshake already reports `"ready"` on
a real machine with zero client setup, yet the documented `bash`/Cygwin fork failure still
reproduces there, and the official Codex VS Code extension hits the sibling WSL-stub failure on the
identical repro) with one Marcode enforces itself: the `app-server` process runs inside a Windows
AppContainer — **write** ACL-scoped to the workspace root(s) a session needs, **read+execute**
granted broadly (the whole user profile), `internetClient` granted by default — so `git`/bash
chains work, `.codex`/per-user interpreter installs/`git fetch` all keep working exactly as they do
unsandboxed, and only writes outside the workspace root are denied at the OS level. This is a
deliberate **write** confinement, not a confidentiality boundary — see the spec's "Non-goals".

**Architecture:** A compiled C# helper (`marcode-sandbox-helper.exe`, built once from source checked
into the repo via the OS-bundled `csc.exe`, cached under `globalStorageUri`) does the Win32 work
Node has no native binding for: derive/create an AppContainer SID with the `internetClient`
capability (SID `S-1-15-3-1`) attached, and launch a target process under that container's security
capability with `STARTUPINFOEX`, its stdio handles pointed straight at the handles Node already
piped to the helper (so the sandboxed grandchild talks directly to Node's pipes, no relay copying),
and a Job Object with `KILL_ON_JOB_CLOSE` so killing the helper always kills the sandboxed process
with it. A pure Node module (`acl.ts`) grants the container SID folder access via `icacls` — once,
broadly, read-only on the user's home directory, and per-session, read-write on each workspace
root — the one part that needs no native call. `codex-provider.ts`'s `spawnAppServer` and
`map-settings.ts`'s `sandboxPolicyOf` branch on `process.platform === 'win32'` to use this path.

**Tech Stack:** TypeScript (Node `child_process`), C# compiled via `csc.exe` (no new npm dependency),
Windows `icacls`. Mocha/`tsx` for unit tests, gated to win32 the same way `codex-gate.ts` gates on
the real binary.

**Spec:** [docs/superpowers/specs/2026-09-23-codex-windows-appcontainer-sandbox-design.md](../specs/2026-09-23-codex-windows-appcontainer-sandbox-design.md)

## Global Constraints

- Windows-only change. macOS/Linux `spawnAppServer`/`sandboxPolicyOf` behavior is untouched.
- No new npm dependency — the helper is compiled from source already in the repo, via
  `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`.
- No visible console window at any point — `CREATE_NO_WINDOW`, never `CREATE_NEW_CONSOLE` (the
  spike used the latter; that is the exact bug the `windowsHide` fix on
  `fix/fix-windows-hide-on-codex` already fixed for the unsandboxed path, and this must not
  reintroduce it for the sandboxed one).
- AppContainer provisioning failure is a probe failure (surfaced as an `error`-status session, same
  path a spawn/handshake failure already takes) — never a silent fallback to unsandboxed spawn.
- Read+execute is granted broadly (the user's home directory), not scoped per-workspace — this is
  the accepted tradeoff from the spec ("write confinement, not filesystem confinement"): the thing
  this design stops is destructive/unexpected **writes**, not reads, and `approvalPolicy` (untouched
  by this design) is still the control on what an agent does with a read, same as it is today with
  no sandbox at all. Only the **write** ACL grant (`F`) is scoped per-session `cwd`.
- **Every ACL grant is temporary.** An `icacls` ACE is NTFS metadata keyed to the container SID and
  outlives the process, the window and a reboot, so: the container name is unique per sandbox
  (`marcode-codex-<pid>-<uuid>`, never a constant), every grant goes through `GrantTracker`, and
  `Sandbox.dispose()` revokes them all and deletes the profile. Nothing calls `icacls` directly
  outside `acl.ts`/`grants.ts`.
- The `internetClient` capability (`S-1-15-3-1`) is always attached to the container — zero
  capabilities blocks all outbound network (DNS resolution itself fails), which would break every
  `git fetch`/`push`/`npm install`/API call a session makes.
- `src/providers/` still imports no `vscode` — `globalStorageUri` for the helper cache is passed in
  as a plain string path from `extension.ts`, the same way other provider construction args are.
- Filenames kebab-case. New folder: `src/providers/codex/windows-sandbox/`.

## Review Focus

- A `cwd` containing spaces or non-ASCII characters passed to the helper's command line — the spike
  used a fixed test path (`C:\marcode-spike-root`); a real workspace path is user-controlled and
  must survive `CreateProcessW`'s command-line quoting rules unescaped-shell-injection-free.
- `spawnSandboxed` called before `grantRoot` has ACL'd the target `cwd` — the very first thread in a
  fresh window's `app-server` process; the ACL grant must happen before the process that will read
  that folder starts, not after.
- The helper binary missing or stale after a Marcode version bump (cached exe from an old
  `helper-source.ts` still on disk) — `build-helper.ts` must key its cache on a hash of the source,
  not just "does a file exist at this path".
- `Duplex.kill()` called while the helper is still mid-startup (before the Job Object assignment
  happens) — killing must not leave an un-tracked, un-killed AppContainer'd `app-server` orphaned.
- A window that crashes or is force-killed never reaches `teardown()`, so its grants stay on disk —
  Task 4's startup sweep (`sweepStale`, keyed on a dead `pid` in the per-window record) is the only
  thing that clears them, and it must not touch a still-running window's record.
- Two VS Code windows open at once — each has its own container name and record file, so neither
  may revoke, delete or overwrite the other's (Task 4 tests: distinct names, live record untouched).
- Non-win32 platforms importing anything from `windows-sandbox/` at module-load time — the folder
  must be reachable only behind the `process.platform === 'win32'` branch, never imported
  unconditionally at the top of `codex-provider.ts` (Win32 API `DllImport` P/Invoke has no meaning
  off Windows, but more importantly a top-level import must not throw or behave oddly under macOS/
  Linux test runs).

---

## Task 1: Folder ACL grant/revoke and the grant tracker (`acl.ts`, `grants.ts`)

**Files:**
- Create: `src/providers/codex/windows-sandbox/acl.ts`
- Create: `src/providers/codex/windows-sandbox/grants.ts`
- Test: `src/test/unit/windows-sandbox-acl.test.ts`, `src/test/unit/windows-sandbox-grants.test.ts`

**Interfaces:**
- Produces: `grantFolderAccess(sid: string, folder: string, mode: 'readwrite' | 'readonly', run?: ExecFn): Promise<void>` and `revokeFolderAccess(sid: string, folder: string, run?: ExecFn): Promise<void>` where `type ExecFn = (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>`, injected so the test never shells a real `icacls`.
- Produces (`grants.ts`): `class GrantTracker { constructor(sid: string, deps?: { grant?: typeof grantFolderAccess; revoke?: typeof revokeFolderAccess }); grant(folder: string, mode: 'readwrite' | 'readonly'): Promise<void>; revoke(folder: string): Promise<void>; revokeAll(): Promise<void>; folders(): string[] }`. Every grant goes through the tracker so nothing is ever written to disk without a matching revoke path. `revokeAll` never throws: it attempts every folder and returns, so one locked folder cannot leave the rest granted.

- [ ] **Step 1: Write the failing test**

```typescript
// src/test/unit/windows-sandbox-acl.test.ts
import * as assert from 'assert';
import { grantFolderAccess, revokeFolderAccess } from '../../providers/codex/windows-sandbox/acl';

suite('grantFolderAccess', () => {
  test('grants full control for readwrite mode', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stderr: '' }; };
    await grantFolderAccess('S-1-15-2-111', 'C:\\work\\repo', 'readwrite', run);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].cmd, 'icacls');
    assert.deepStrictEqual(calls[0].args, ['C:\\work\\repo', '/grant', '*S-1-15-2-111:(OI)(CI)F']);
  });

  test('grants read+execute for readonly mode', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stderr: '' }; };
    await grantFolderAccess('S-1-15-2-111', 'C:\\work\\repo', 'readonly', run);
    assert.deepStrictEqual(calls[0].args, ['C:\\work\\repo', '/grant', '*S-1-15-2-111:(OI)(CI)RX']);
  });

  test('rejects on a nonzero exit code, carrying stderr', async () => {
    const run = async () => ({ code: 1, stderr: 'The system cannot find the file specified.' });
    await assert.rejects(
      grantFolderAccess('S-1-15-2-111', 'C:\\missing', 'readwrite', run),
      /icacls failed.*The system cannot find the file specified\./s,
    );
  });

  test('revokes with /remove for exactly that SID', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { code: 0, stderr: '' }; };
    await revokeFolderAccess('S-1-15-2-111', 'C:\\work\\repo', run);
    assert.deepStrictEqual(calls[0].args, ['C:\\work\\repo', '/remove', '*S-1-15-2-111']);
  });
});
```

```typescript
// src/test/unit/windows-sandbox-grants.test.ts
import * as assert from 'assert';
import { GrantTracker } from '../../providers/codex/windows-sandbox/grants';

function fakeDeps() {
  const log: string[] = [];
  return {
    log,
    deps: {
      grant: async (sid: string, folder: string, mode: string) => { log.push(`grant:${mode}:${folder}`); },
      revoke: async (sid: string, folder: string) => { log.push(`revoke:${folder}`); },
    },
  };
}

suite('GrantTracker', () => {
  test('records every grant and revokes each one on revokeAll', async () => {
    const { log, deps } = fakeDeps();
    const tracker = new GrantTracker('S-1-15-2-1', deps as never);
    await tracker.grant('C:\\a', 'readwrite');
    await tracker.grant('C:\\b', 'readonly');
    await tracker.revokeAll();
    assert.deepStrictEqual(log, ['grant:readwrite:C:\\a', 'grant:readonly:C:\\b', 'revoke:C:\\a', 'revoke:C:\\b']);
    assert.deepStrictEqual(tracker.folders(), []);
  });

  test('revoke removes exactly one folder and leaves the rest tracked', async () => {
    const { log, deps } = fakeDeps();
    const tracker = new GrantTracker('S-1-15-2-1', deps as never);
    await tracker.grant('C:\\a', 'readwrite');
    await tracker.grant('C:\\b', 'readwrite');
    await tracker.revoke('C:\\a');
    assert.deepStrictEqual(tracker.folders(), ['C:\\b']);
    assert.strictEqual(log[log.length - 1], 'revoke:C:\\a');
  });

  test('revokeAll attempts every folder even when one revoke fails, and does not throw', async () => {
    const attempted: string[] = [];
    const tracker = new GrantTracker('S-1-15-2-1', {
      grant: async () => {},
      revoke: async (_sid: string, folder: string) => { attempted.push(folder); if (folder === 'C:\\a') { throw new Error('locked'); } },
    } as never);
    await tracker.grant('C:\\a', 'readwrite');
    await tracker.grant('C:\\b', 'readwrite');
    await tracker.revokeAll();
    assert.deepStrictEqual(attempted, ['C:\\a', 'C:\\b']);
  });

  test('a failed grant is not recorded, so it is never "revoked"', async () => {
    const tracker = new GrantTracker('S-1-15-2-1', {
      grant: async () => { throw new Error('icacls failed'); },
      revoke: async () => {},
    } as never);
    await assert.rejects(tracker.grant('C:\\a', 'readwrite'), /icacls failed/);
    assert.deepStrictEqual(tracker.folders(), []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit:raw --grep "grantFolderAccess|GrantTracker"`
Expected: FAIL — `Cannot find module '../../providers/codex/windows-sandbox/acl'` (and `grants`)

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/providers/codex/windows-sandbox/acl.ts
import { spawn } from 'node:child_process';

export type ExecFn = (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>;

const defaultRun: ExecFn = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { windowsHide: true });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on('error', reject);
  child.on('exit', (code) => { resolve({ code: code ?? 1, stderr }); });
});

/**
 * Grants an AppContainer SID access to a folder, inherited by every file and
 * subfolder created under it (`(OI)(CI)`) — the AppContainer token keeps
 * SeChangeNotifyPrivilege, so only this leaf needs an explicit ACE, never its
 * ancestors (verified by the spike this design is built on).
 */
export async function grantFolderAccess(
  sid: string, folder: string, mode: 'readwrite' | 'readonly', run: ExecFn = defaultRun,
): Promise<void> {
  const perm = mode === 'readwrite' ? 'F' : 'RX';
  const { code, stderr } = await run('icacls', [folder, '/grant', `*${sid}:(OI)(CI)${perm}`]);
  if (code !== 0) {
    throw new Error(`icacls failed (exit ${code}) granting ${sid} on ${folder}: ${stderr.trim()}`);
  }
}

/** Removes every ACE for this SID on the folder — the inverse of `grantFolderAccess`. */
export async function revokeFolderAccess(
  sid: string, folder: string, run: ExecFn = defaultRun,
): Promise<void> {
  const { code, stderr } = await run('icacls', [folder, '/remove', `*${sid}`]);
  if (code !== 0) {
    throw new Error(`icacls failed (exit ${code}) revoking ${sid} on ${folder}: ${stderr.trim()}`);
  }
}
```

```typescript
// src/providers/codex/windows-sandbox/grants.ts
import { grantFolderAccess, revokeFolderAccess } from './acl';

type Mode = 'readwrite' | 'readonly';

/**
 * An ACE written by `icacls` is NTFS metadata keyed to the container SID: it
 * outlives the process, the window and a reboot. Routing every grant through
 * this tracker is what makes "revoke on dispose" possible at all — a grant
 * made outside it has no revoke path.
 */
export class GrantTracker {
  private readonly granted = new Map<string, Mode>();
  private readonly grantFn: typeof grantFolderAccess;
  private readonly revokeFn: typeof revokeFolderAccess;

  constructor(
    private readonly sid: string,
    deps: { grant?: typeof grantFolderAccess; revoke?: typeof revokeFolderAccess } = {},
  ) {
    this.grantFn = deps.grant ?? grantFolderAccess;
    this.revokeFn = deps.revoke ?? revokeFolderAccess;
  }

  async grant(folder: string, mode: Mode): Promise<void> {
    await this.grantFn(this.sid, folder, mode);
    this.granted.set(folder, mode);
  }

  async revoke(folder: string): Promise<void> {
    await this.revokeFn(this.sid, folder);
    this.granted.delete(folder);
  }

  /** Attempts every folder; one failure must not leave the others granted. */
  async revokeAll(): Promise<void> {
    for (const folder of [...this.granted.keys()]) {
      try { await this.revoke(folder); } catch { /* best-effort: startup sweep catches leftovers */ }
    }
    this.granted.clear();
  }

  folders(): string[] { return [...this.granted.keys()]; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit:raw --grep "grantFolderAccess|GrantTracker"`
Expected: PASS (4 + 4 passing)

- [ ] **Step 5: Commit**

```bash
git add src/providers/codex/windows-sandbox/acl.ts src/providers/codex/windows-sandbox/grants.ts src/test/unit/windows-sandbox-acl.test.ts src/test/unit/windows-sandbox-grants.test.ts
git commit -m "feat: add icacls grant/revoke and a tracker that can undo every grant"
```

---

## Task 2: Helper source and cached build (`helper-source.ts`, `build-helper.ts`)

**Files:**
- Create: `src/providers/codex/windows-sandbox/helper-source.ts`
- Create: `src/providers/codex/windows-sandbox/build-helper.ts`
- Test: `src/test/unit/windows-sandbox-build-helper.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `HELPER_SOURCE: string` (the C# source, exported for hashing and for the compile step); `buildHelper(cacheDir: string, opts?: { compile?: CompileFn; exists?: ExistsFn }): Promise<string>` returning the path to a ready-to-run `marcode-sandbox-helper.exe`, where `type CompileFn = (csSourcePath: string, exePath: string) => Promise<{ code: number; stderr: string }>` and `type ExistsFn = (path: string) => boolean`, both injected for the test.

- [ ] **Step 1: Write the failing test**

```typescript
// src/test/unit/windows-sandbox-build-helper.test.ts
import * as assert from 'assert';
import { buildHelper } from '../../providers/codex/windows-sandbox/build-helper';
import { HELPER_SOURCE } from '../../providers/codex/windows-sandbox/helper-source';
import { createHash } from 'node:crypto';

suite('buildHelper', () => {
  const hash = createHash('sha256').update(HELPER_SOURCE).digest('hex').slice(0, 16);
  const cachedExe = `C:\\cache\\marcode-sandbox-helper.${hash}.exe`;

  test('reuses a cached exe matching the current source hash without compiling', async () => {
    let compiled = false;
    const path = await buildHelper('C:\\cache', {
      exists: (p) => p === cachedExe,
      compile: async () => { compiled = true; return { code: 0, stderr: '' }; },
    });
    assert.strictEqual(path, cachedExe);
    assert.strictEqual(compiled, false);
  });

  test('compiles when no cached exe matches the current hash', async () => {
    const compileCalls: { csSourcePath: string; exePath: string }[] = [];
    const path = await buildHelper('C:\\cache', {
      exists: () => false,
      compile: async (csSourcePath, exePath) => { compileCalls.push({ csSourcePath, exePath }); return { code: 0, stderr: '' }; },
    });
    assert.strictEqual(path, cachedExe);
    assert.strictEqual(compileCalls.length, 1);
    assert.strictEqual(compileCalls[0].exePath, cachedExe);
  });

  test('rejects when csc.exe fails', async () => {
    await assert.rejects(
      buildHelper('C:\\cache', { exists: () => false, compile: async () => ({ code: 1, stderr: 'CS0000: bad' }) }),
      /csc\.exe failed.*CS0000: bad/s,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit:raw --grep buildHelper`
Expected: FAIL — modules don't exist yet

- [ ] **Step 3: Write minimal implementation**

`helper-source.ts` holds the C# adapted from the verified spike (`%TEMP%\marcode-appcontainer-spike\Spike.cs`), with the two changes the spec calls out: stdio comes from the helper's own inherited handles (so Node's pipes reach the sandboxed grandchild directly, no byte-copying in C#) instead of files, `CREATE_NO_WINDOW` instead of `CREATE_NEW_CONSOLE`, and a Job Object so killing the helper kills the grandchild with it.

```typescript
// src/providers/codex/windows-sandbox/helper-source.ts
export const HELPER_SOURCE = `
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

class MarcodeSandboxHelper
{
    const int PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint CREATE_SUSPENDED = 0x00000004;
    const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }

    [StructLayout(LayoutKind.Sequential)]
    struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    const uint SE_GROUP_ENABLED = 0x00000004;
    // The well-known internetClient capability — granted by default so
    // outbound network (git fetch/push, npm install, any API call) works
    // inside the container; a zero-capability AppContainer blocks all
    // outbound network at the WFP layer, confirmed by the spike this design
    // is built on (DNS resolution itself failed, curl exit 6).
    const string INTERNET_CLIENT_SID = "S-1-15-3-1";

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFO
    {
        public int cb; public IntPtr lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit; public IntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, int capCount, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr sidString);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSidToSidW(string sidString, out IntPtr sid);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr mem);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prevValue, IntPtr returnSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string appName, StringBuilder cmdLine, IntPtr procAttr, IntPtr threadAttr,
        bool inheritHandles, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION procInfo);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int DeleteAppContainerProfile(string name);

    // The container name is a per-window argument, never a constant: an ACE
    // is keyed to this SID and persists on disk, so a shared name would make
    // every grant global to every window and workspace on the machine.
    static IntPtr EnsureSid(string name)
    {
        IntPtr sid;
        int hr = CreateAppContainerProfile(name, "Marcode Codex Sandbox", "Scopes one codex app-server to its granted folders", IntPtr.Zero, 0, out sid);
        if (hr == unchecked((int)0x800700B7)) { DeriveAppContainerSidFromAppContainerName(name, out sid); }
        else if (hr != 0) { throw new Exception("CreateAppContainerProfile failed hr=0x" + hr.ToString("X8")); }
        return sid;
    }

    static int Main(string[] args)
    {
        const string usage = "usage: sid <name> | delete <name> | run <name> <cwd> <exe> <args...>";
        if (args.Length < 2) { Console.Error.WriteLine(usage); return 2; }
        string name = args[1];

        if (args[0] == "sid")
        {
            IntPtr sid = EnsureSid(name);
            IntPtr strPtr; ConvertSidToStringSidW(sid, out strPtr);
            Console.WriteLine(Marshal.PtrToStringUni(strPtr));
            LocalFree(strPtr);
            return 0;
        }

        if (args[0] == "delete") { return DeleteAppContainerProfile(name) == 0 ? 0 : 1; }

        if (args[0] != "run" || args.Length < 4) { Console.Error.WriteLine(usage); return 2; }
        string cwd = args[2], exe = args[3];
        var cmd = new StringBuilder("\"" + exe + "\"");
        for (int i = 4; i < args.Length; i++) { cmd.Append(" \"" + args[i].Replace("\"", "\\\"") + "\""); }

        IntPtr sidHandle = EnsureSid(name);

        IntPtr internetClientSid;
        if (!ConvertStringSidToSidW(INTERNET_CLIENT_SID, out internetClientSid))
        {
            Console.Error.WriteLine("ConvertStringSidToSidW(internetClient) failed err=" + Marshal.GetLastWin32Error());
            return 1;
        }
        var capAttr = new SID_AND_ATTRIBUTES { Sid = internetClientSid, Attributes = SE_GROUP_ENABLED };
        IntPtr capsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(capAttr));
        Marshal.StructureToPtr(capAttr, capsPtr, false);

        var secCap = new SECURITY_CAPABILITIES { AppContainerSid = sidHandle, Capabilities = capsPtr, CapabilityCount = 1 };
        IntPtr secCapPtr = Marshal.AllocHGlobal(Marshal.SizeOf(secCap));
        Marshal.StructureToPtr(secCap, secCapPtr, false);

        IntPtr listSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref listSize);
        IntPtr attrList = Marshal.AllocHGlobal(listSize);
        InitializeProcThreadAttributeList(attrList, 1, 0, ref listSize);
        UpdateProcThreadAttribute(attrList, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, secCapPtr, (IntPtr)Marshal.SizeOf(secCap), IntPtr.Zero, IntPtr.Zero);

        var si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(si);
        si.lpAttributeList = attrList;
        // The helper's own stdin/stdout/stderr are the pipes Node already
        // created when it spawned THIS process — handing them straight to
        // the grandchild means the sandboxed app-server talks to Node's
        // pipes directly, no relay copying needed in this process.
        si.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        si.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        si.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        si.StartupInfo.dwFlags |= 0x100; // STARTF_USESTDHANDLES

        PROCESS_INFORMATION pi;
        uint flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | CREATE_SUSPENDED;
        bool ok = CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, cwd, ref si, out pi);
        if (!ok) { Console.Error.WriteLine("CreateProcess failed err=" + Marshal.GetLastWin32Error()); return 1; }

        // Job Object with KILL_ON_JOB_CLOSE: this helper process holds the
        // only handle to the job, so when it exits (including being killed
        // by Node) Windows tears the sandboxed grandchild down with it —
        // there is no other way to reach into an AppContainer'd process
        // from outside once launched.
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(limits));
        AssignProcessToJobObject(job, pi.hProcess);
        ResumeThread(pi.hThread);

        WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
        uint exitCode;
        GetExitCodeProcess(pi.hProcess, out exitCode);
        return (int)exitCode;
    }
}
`;
```

```typescript
// src/providers/codex/windows-sandbox/build-helper.ts
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { HELPER_SOURCE } from './helper-source';

export type CompileFn = (csSourcePath: string, exePath: string) => Promise<{ code: number; stderr: string }>;
export type ExistsFn = (p: string) => boolean;

const CSC = String.raw`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`;

const defaultCompile: CompileFn = (csSourcePath, exePath) => new Promise((resolve, reject) => {
  const child = spawn(CSC, ['/nologo', `/out:${exePath}`, csSourcePath], { windowsHide: true });
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on('error', reject);
  child.on('exit', (code) => { resolve({ code: code ?? 1, stderr }); });
});

/**
 * Cache key is a hash of the source, not "does a file exist at this path" —
 * a Marcode version bump that changes `helper-source.ts` must not keep
 * running a stale compiled helper forever.
 */
export async function buildHelper(
  cacheDir: string, opts: { compile?: CompileFn; exists?: ExistsFn } = {},
): Promise<string> {
  const compile = opts.compile ?? defaultCompile;
  const exists = opts.exists ?? existsSync;
  const hash = createHash('sha256').update(HELPER_SOURCE).digest('hex').slice(0, 16);
  const exePath = path.join(cacheDir, `marcode-sandbox-helper.${hash}.exe`);
  if (exists(exePath)) { return exePath; }

  if (!existsSync(cacheDir)) { mkdirSync(cacheDir, { recursive: true }); }
  const csSourcePath = path.join(cacheDir, `marcode-sandbox-helper.${hash}.cs`);
  writeFileSync(csSourcePath, HELPER_SOURCE, 'utf8');
  const { code, stderr } = await compile(csSourcePath, exePath);
  if (code !== 0) {
    throw new Error(`csc.exe failed (exit ${code}) compiling the sandbox helper: ${stderr.trim()}`);
  }
  return exePath;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit:raw --grep buildHelper`
Expected: PASS (3 passing)

- [ ] **Step 5: Commit**

```bash
git add src/providers/codex/windows-sandbox/helper-source.ts src/providers/codex/windows-sandbox/build-helper.ts src/test/unit/windows-sandbox-build-helper.test.ts
git commit -m "feat: compile and cache the AppContainer sandbox helper"
```

---

## Task 3: Real win32 integration test for the helper

**Files:**
- Test: `src/test/unit/windows-sandbox-helper-gate.ts` (gate module, mirrors `codex-gate.ts`)
- Test: `src/test/unit/windows-sandbox-helper.test.ts`

**Interfaces:**
- Consumes: `buildHelper` (Task 2), `grantFolderAccess` (Task 1).
- Produces: nothing new — this is a real-binary integration test, not a unit under test.

- [ ] **Step 1: Write the gate**

```typescript
// src/test/unit/windows-sandbox-helper-gate.ts
/**
 * Mirrors codex-gate.ts: skips this suite everywhere except a real win32
 * machine. P/Invoke AppContainer APIs and csc.exe have no meaning on
 * macOS/Linux CI, and no meaningful fake to stand in for "did Windows
 * actually deny this write".
 */
export const shouldRunWindowsSandboxTests = process.platform === 'win32';
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/test/unit/windows-sandbox-helper.test.ts
import * as assert from 'assert';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { buildHelper } from '../../providers/codex/windows-sandbox/build-helper';
import { grantFolderAccess } from '../../providers/codex/windows-sandbox/acl';
import { shouldRunWindowsSandboxTests } from './windows-sandbox-helper-gate';

(shouldRunWindowsSandboxTests ? suite : suite.skip)('sandbox helper (real binary)', () => {
  // Unique per test run: profiles persist in the OS until deleted, so a
  // shared name would let one run's leftover grants satisfy another's asserts.
  const CONTAINER = `marcode-test-${process.pid}-${Date.now()}`;
  let helperForCleanup: string | undefined;

  suiteTeardown(() => {
    if (helperForCleanup) { spawnSync(helperForCleanup, ['delete', CONTAINER], { windowsHide: true }); }
  });

  test('spawns a nested child (cmd -> a marker file) inside the granted root, denies outside it', async function () {
    this.timeout(20000);
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'marcode-sandbox-cache-'));
    const helperPath = await buildHelper(cacheDir);

    const sid = await new Promise<string>((resolve, reject) => {
      const child = spawn(helperPath, ['sid', CONTAINER], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
      child.on('exit', (code) => { code === 0 ? resolve(out.trim()) : reject(new Error(`sid exit ${code}`)); });
    });

    const root = mkdtempSync(path.join(tmpdir(), 'marcode-sandbox-root-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'marcode-sandbox-outside-'));
    await grantFolderAccess(sid, root, 'readwrite');

    const insideMarker = path.join(root, 'inside.txt');
    const outsideMarker = path.join(outside, 'outside.txt');
    const script = `cmd /c (echo hi > "${insideMarker}") & (echo hi > "${outsideMarker}" 2>nul)`;
    writeFileSync(path.join(root, 'run.cmd'), script);

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(helperPath, ['run', CONTAINER, root, 'cmd.exe', '/c', path.join(root, 'run.cmd')], { windowsHide: true });
      child.on('exit', (code) => { code === null ? reject(new Error('killed')) : resolve(code); });
      child.on('error', reject);
    });

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(existsSync(insideMarker), true, 'write inside the granted root must succeed');
    assert.strictEqual(existsSync(outsideMarker), false, 'write outside the granted root must be denied');
  });

  test('a root path containing a space survives the helper command line unescaped', async function () {
    this.timeout(20000);
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'marcode-sandbox-cache-'));
    const helperPath = await buildHelper(cacheDir);
    helperForCleanup = helperPath;
    const sid = await new Promise<string>((resolve, reject) => {
      const child = spawn(helperPath, ['sid', CONTAINER], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
      child.on('exit', (code) => { code === 0 ? resolve(out.trim()) : reject(new Error(`sid exit ${code}`)); });
    });

    const root = mkdtempSync(path.join(tmpdir(), 'marcode sandbox spaced root-'));
    await grantFolderAccess(sid, root, 'readwrite');
    const marker = path.join(root, 'inside.txt');
    writeFileSync(path.join(root, 'run.cmd'), `cmd /c echo hi > "${marker}"`);

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(helperPath, ['run', CONTAINER, root, 'cmd.exe', '/c', path.join(root, 'run.cmd')], { windowsHide: true });
      child.on('exit', (code) => { code === null ? reject(new Error('killed')) : resolve(code); });
      child.on('error', reject);
    });

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(existsSync(marker), true, 'a spaced cwd/args path must reach CreateProcessW intact');
  });

  test('outbound network works inside the container (internetClient capability)', async function () {
    this.timeout(20000);
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'marcode-sandbox-cache-'));
    const helperPath = await buildHelper(cacheDir);
    const root = mkdtempSync(path.join(tmpdir(), 'marcode-sandbox-net-'));
    const outFile = path.join(root, 'curl-status.txt');
    writeFileSync(
      path.join(root, 'run.cmd'),
      `curl -s -o nul -w "%%{http_code}" https://github.com > "${outFile}" 2>nul`,
    );

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(helperPath, ['run', CONTAINER, root, 'cmd.exe', '/c', path.join(root, 'run.cmd')], { windowsHide: true });
      child.on('exit', (code) => { code === null ? reject(new Error('killed')) : resolve(code); });
      child.on('error', reject);
    });

    assert.strictEqual(exitCode, 0);
    const status = readFileSync(outFile, 'utf8').trim();
    assert.strictEqual(status, '200', `expected a live HTTP 200 through the internetClient capability, got "${status}"`);
  });

  test('the read+execute grant reaches outside the workspace root (write confinement, not filesystem confinement)', async function () {
    this.timeout(20000);
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'marcode-sandbox-cache-'));
    const helperPath = await buildHelper(cacheDir);
    helperForCleanup = helperPath;
    const sid = await new Promise<string>((resolve, reject) => {
      const child = spawn(helperPath, ['sid', CONTAINER], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
      child.on('exit', (code) => { code === 0 ? resolve(out.trim()) : reject(new Error(`sid exit ${code}`)); });
    });

    // Read-only, deliberately outside any workspace root — this is the
    // profile-wide broad-read grant, distinct from the per-session write
    // grant the earlier tests in this suite exercise.
    const readOnlyRoot = mkdtempSync(path.join(tmpdir(), 'marcode-sandbox-readonly-'));
    const preExisting = path.join(readOnlyRoot, 'preexisting.txt');
    writeFileSync(preExisting, 'hello');
    await grantFolderAccess(sid, readOnlyRoot, 'readonly');

    const readOutFile = path.join(readOnlyRoot, 'read-result.txt');
    const writeAttempt = path.join(readOnlyRoot, 'should-not-exist.txt');
    const script = `cmd /c (type "${preExisting}" > "${readOutFile}") & (echo nope > "${writeAttempt}" 2>nul)`;
    writeFileSync(path.join(readOnlyRoot, 'run.cmd'), script);

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(helperPath, ['run', CONTAINER, readOnlyRoot, 'cmd.exe', '/c', path.join(readOnlyRoot, 'run.cmd')], { windowsHide: true });
      child.on('exit', (code) => { code === null ? reject(new Error('killed')) : resolve(code); });
      child.on('error', reject);
    });

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(readFileSync(readOutFile, 'utf8').trim(), 'hello', 'a readonly grant must still allow reads');
    assert.strictEqual(existsSync(writeAttempt), false, 'a readonly grant must still deny writes');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run (on a Windows machine): `yarn test:unit:raw --grep "sandbox helper"`
Expected: FAIL until Task 2's `build-helper.ts`/`acl.ts` exist and actually compile — if Tasks 1-2
are already committed this should instead reveal any gap between the spike-verified P/Invoke and
the adapted helper (e.g. a struct layout mistake made while adapting stdio handling).

- [ ] **Step 4: Fix until it passes**

No new production code in this task — this is where adaptation bugs in Task 2's `helper-source.ts`
get caught and fixed in place (re-edit that file, re-run). Expected failure modes to watch for,
carried over from the spike's own gotchas: `cmd.exe`'s *own* `dir`/`cd /d` fail with a generic
Access Denied inside the container regardless of ACLs (that's `cmd`'s volume-query call, not a
folder permission problem) — this test uses `echo >` redirection instead of `dir` for exactly that
reason, matching the spike's own workaround.

Run: `yarn test:unit:raw --grep "sandbox helper"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/test/unit/windows-sandbox-helper-gate.ts src/test/unit/windows-sandbox-helper.test.ts
git commit -m "test: gate a real AppContainer nested-spawn + fs-scoping check on win32"
```

---

## Task 4: Per-window sandbox (`state.ts`, `index.ts`)

**Files:**
- Create: `src/providers/codex/windows-sandbox/state.ts`
- Create: `src/providers/codex/windows-sandbox/index.ts`
- Test: `src/test/unit/windows-sandbox-state.test.ts`, `src/test/unit/windows-sandbox-index.test.ts`

**Interfaces:**
- Consumes: `buildHelper` (Task 2), `GrantTracker` / `grantFolderAccess` / `revokeFolderAccess` (Task 1), `Duplex` from `src/providers/codex/app-server.ts` (already defined: `{ stdin, stdout, kill(), onFailure(cb) }`, the shape `spawnAppServer` already returns — see `codex-provider.ts:105-110`).
- Produces (`state.ts`): `interface SandboxRecord { name: string; sid: string; pid: number; folders: string[] }`; `writeRecord(dir: string, rec: SandboxRecord): void`; `removeRecord(dir: string, name: string): void`; `sweepStale(dir: string, deps: { isAlive?: (pid: number) => boolean; revoke?: typeof revokeFolderAccess; deleteProfile: (name: string) => Promise<void> }): Promise<string[]>` returning the names it cleaned. One JSON file per window (`sandbox-<name>.json`), never one shared file, so two windows never race on a write.
- Produces (`index.ts`): `createSandbox(cacheDir: string, deps?: SandboxDeps): Promise<Sandbox>` where `interface Sandbox { readonly name: string; spawn(bin: string, args: string[], cwd: string, opts?: { writable?: boolean }): Promise<Duplex>; grant(folder: string, mode: 'readwrite' | 'readonly'): Promise<void>; revoke(folder: string): Promise<void>; dispose(): Promise<void> }`. `spawn` grants read on `homeDir()` once per sandbox and write on `cwd` unless `writable: false` (the `plan` case). `dispose` revokes every recorded grant, deletes the profile and removes the record.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/test/unit/windows-sandbox-state.test.ts
import * as assert from 'assert';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { writeRecord, removeRecord, sweepStale } from '../../providers/codex/windows-sandbox/state';

suite('sweepStale', () => {
  const rec = (name: string, pid: number, folders: string[]) => ({ name, sid: `S-1-15-2-${pid}`, pid, folders });

  test('revokes and deletes a record whose owning process is gone, leaves a live one alone', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'marcode-sweep-'));
    writeRecord(dir, rec('dead', 111, ['C:\\a', 'C:\\b']));
    writeRecord(dir, rec('live', 222, ['C:\\c']));
    const revoked: string[] = [];
    const deleted: string[] = [];

    const cleaned = await sweepStale(dir, {
      isAlive: (pid) => pid === 222,
      revoke: async (sid, folder) => { revoked.push(`${sid}:${folder}`); },
      deleteProfile: async (name) => { deleted.push(name); },
    });

    assert.deepStrictEqual(cleaned, ['dead']);
    assert.deepStrictEqual(revoked, ['S-1-15-2-111:C:\\a', 'S-1-15-2-111:C:\\b']);
    assert.deepStrictEqual(deleted, ['dead']);
    assert.strictEqual(existsSync(path.join(dir, 'sandbox-dead.json')), false);
    assert.strictEqual(existsSync(path.join(dir, 'sandbox-live.json')), true);
  });

  test('a folder that fails to revoke does not stop the rest, and the record is still cleared', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'marcode-sweep-'));
    writeRecord(dir, rec('dead', 111, ['C:\\gone', 'C:\\b']));
    const revoked: string[] = [];
    await sweepStale(dir, {
      isAlive: () => false,
      revoke: async (_sid, folder) => { revoked.push(folder); if (folder === 'C:\\gone') { throw new Error('missing'); } },
      deleteProfile: async () => {},
    });
    assert.deepStrictEqual(revoked, ['C:\\gone', 'C:\\b']);
    assert.strictEqual(existsSync(path.join(dir, 'sandbox-dead.json')), false);
  });

  test('a corrupt record file is skipped, not thrown on', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'marcode-sweep-'));
    writeFileSync(path.join(dir, 'sandbox-bad.json'), '{not json');
    const cleaned = await sweepStale(dir, { isAlive: () => false, revoke: async () => {}, deleteProfile: async () => {} });
    assert.deepStrictEqual(cleaned, []);
  });

  test('removeRecord deletes only that window\'s file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'marcode-sweep-'));
    writeRecord(dir, rec('a', 1, []));
    writeRecord(dir, rec('b', 2, []));
    removeRecord(dir, 'a');
    assert.strictEqual(existsSync(path.join(dir, 'sandbox-a.json')), false);
    assert.strictEqual(existsSync(path.join(dir, 'sandbox-b.json')), true);
  });
});
```

```typescript
// src/test/unit/windows-sandbox-index.test.ts
import * as assert from 'assert';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { createSandbox } from '../../providers/codex/windows-sandbox/index';

function harness() {
  const calls: string[] = [];
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'marcode-sandbox-idx-'));
  let spawnedArgs: string[] = [];
  const fakeChild = { stdin: new PassThrough(), stdout: new PassThrough(), kill: () => { calls.push('kill'); }, on: () => {}, pid: 1 };
  const deps = {
    build: async () => 'C:\\cache\\helper.exe',
    sid: async (_h: string, name: string) => { calls.push(`sid:${name.startsWith('marcode-codex-')}`); return 'S-1-15-2-999'; },
    homeDir: () => 'C:\\Users\\dev',
    grant: async (_sid: string, folder: string, mode: string) => { calls.push(`grant:${mode}:${folder}`); },
    revoke: async (_sid: string, folder: string) => { calls.push(`revoke:${folder}`); },
    deleteProfile: async (name: string) => { calls.push(`delete:${name.startsWith('marcode-codex-')}`); },
    isAlive: () => true,
    spawn: (bin: string, args: string[]) => { spawnedArgs = args; calls.push(`spawn:${bin}`); return fakeChild as never; },
  };
  return { calls, cacheDir, deps, fakeChild, args: () => spawnedArgs };
}

suite('createSandbox', () => {
  test('spawn grants read on home once, write on cwd, then runs under this window\'s container name', async () => {
    const h = harness();
    const sandbox = await createSandbox(h.cacheDir, h.deps as never);
    const child = await sandbox.spawn('codex.exe', ['app-server'], 'C:\\work\\repo');

    assert.deepStrictEqual(h.calls, [
      'sid:true', 'grant:readonly:C:\\Users\\dev', 'grant:readwrite:C:\\work\\repo', 'spawn:C:\\cache\\helper.exe',
    ]);
    assert.deepStrictEqual(h.args().slice(0, 1), ['run']);
    assert.strictEqual(h.args()[1], sandbox.name);
    assert.deepStrictEqual(h.args().slice(2), ['C:\\work\\repo', 'codex.exe', 'app-server']);
    assert.strictEqual(child.stdin, h.fakeChild.stdin);
  });

  test('a second spawn does not re-grant home', async () => {
    const h = harness();
    const sandbox = await createSandbox(h.cacheDir, h.deps as never);
    await sandbox.spawn('codex.exe', ['app-server'], 'C:\\a');
    await sandbox.spawn('codex.exe', ['app-server'], 'C:\\b');
    assert.strictEqual(h.calls.filter((c) => c === 'grant:readonly:C:\\Users\\dev').length, 1);
  });

  test('writable: false (plan mode) grants no write anywhere', async () => {
    const h = harness();
    const sandbox = await createSandbox(h.cacheDir, h.deps as never);
    await sandbox.spawn('codex.exe', ['app-server'], 'C:\\work\\repo', { writable: false });
    assert.strictEqual(h.calls.some((c) => c.startsWith('grant:readwrite')), false);
  });

  test('two sandboxes get distinct container names', async () => {
    const a = await createSandbox(harness().cacheDir, harness().deps as never);
    const b = await createSandbox(harness().cacheDir, harness().deps as never);
    assert.notStrictEqual(a.name, b.name);
  });

  test('dispose revokes every grant, deletes the profile and removes the record', async () => {
    const h = harness();
    const sandbox = await createSandbox(h.cacheDir, h.deps as never);
    await sandbox.spawn('codex.exe', ['app-server'], 'C:\\work\\repo');
    await sandbox.grant('C:\\extra', 'readwrite');
    assert.strictEqual(readdirSync(h.cacheDir).some((f) => f.startsWith('sandbox-')), true);
    h.calls.length = 0;

    await sandbox.dispose();

    assert.deepStrictEqual(h.calls.filter((c) => c.startsWith('revoke:')).sort(), [
      'revoke:C:\\Users\\dev', 'revoke:C:\\extra', 'revoke:C:\\work\\repo',
    ]);
    assert.strictEqual(h.calls.includes('delete:true'), true);
    assert.strictEqual(readdirSync(h.cacheDir).some((f) => f.startsWith('sandbox-')), false);
  });

  test('startup sweeps a stale record left by a crashed window before creating its own', async () => {
    const h = harness();
    const { writeRecord } = await import('../../providers/codex/windows-sandbox/state');
    writeRecord(h.cacheDir, { name: 'marcode-codex-old', sid: 'S-1-15-2-1', pid: 999999, folders: ['C:\\stale'] });
    await createSandbox(h.cacheDir, { ...h.deps, isAlive: () => false } as never);
    assert.strictEqual(h.calls.includes('revoke:C:\\stale'), true);
    assert.strictEqual(existsSync(path.join(h.cacheDir, 'sandbox-marcode-codex-old.json')), false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit:raw --grep "sweepStale|createSandbox"`
Expected: FAIL — modules don't exist

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/providers/codex/windows-sandbox/state.ts
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { revokeFolderAccess } from './acl';

export interface SandboxRecord { name: string; sid: string; pid: number; folders: string[] }

// One file per window: two windows never race on a shared write.
const fileOf = (dir: string, name: string) => path.join(dir, `sandbox-${name}.json`);

export function writeRecord(dir: string, rec: SandboxRecord): void {
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }
  writeFileSync(fileOf(dir, rec.name), JSON.stringify(rec), 'utf8');
}

export function removeRecord(dir: string, name: string): void {
  try { unlinkSync(fileOf(dir, name)); } catch { /* already gone */ }
}

const defaultIsAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * Cleans up after windows that died without running `dispose`. An ACE is
 * NTFS metadata keyed to its window's SID, so a crash leaves it on disk for
 * good unless something removes it.
 */
export async function sweepStale(
  dir: string,
  deps: { isAlive?: (pid: number) => boolean; revoke?: typeof revokeFolderAccess; deleteProfile: (name: string) => Promise<void> },
): Promise<string[]> {
  if (!existsSync(dir)) { return []; }
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const revoke = deps.revoke ?? revokeFolderAccess;
  const cleaned: string[] = [];

  for (const file of readdirSync(dir).filter((f) => f.startsWith('sandbox-') && f.endsWith('.json'))) {
    let rec: SandboxRecord;
    try { rec = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as SandboxRecord; } catch { continue; }
    if (isAlive(rec.pid)) { continue; }
    for (const folder of rec.folders) {
      try { await revoke(rec.sid, folder); } catch { /* folder deleted or locked: nothing to revoke */ }
    }
    try { await deps.deleteProfile(rec.name); } catch { /* profile already gone */ }
    removeRecord(dir, rec.name);
    cleaned.push(rec.name);
  }
  return cleaned;
}
```

```typescript
// src/providers/codex/windows-sandbox/index.ts
import { spawn as spawnChildProcess, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { Duplex } from '../app-server';
import { grantFolderAccess, revokeFolderAccess } from './acl';
import { buildHelper } from './build-helper';
import { GrantTracker } from './grants';
import { removeRecord, sweepStale, writeRecord } from './state';

type SpawnFn = (bin: string, args: string[]) => {
  stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; kill(): void;
  on(event: string, cb: (...a: unknown[]) => void): void;
};

export interface SandboxDeps {
  build?: typeof buildHelper;
  sid?: (helperPath: string, name: string) => Promise<string>;
  homeDir?: () => string;
  grant?: typeof grantFolderAccess;
  revoke?: typeof revokeFolderAccess;
  deleteProfile?: (name: string) => Promise<void>;
  isAlive?: (pid: number) => boolean;
  spawn?: SpawnFn;
}

export interface Sandbox {
  readonly name: string;
  spawn(bin: string, args: string[], cwd: string, opts?: { writable?: boolean }): Promise<Duplex>;
  grant(folder: string, mode: 'readwrite' | 'readonly'): Promise<void>;
  revoke(folder: string): Promise<void>;
  dispose(): Promise<void>;
}

const defaultSpawn: SpawnFn = (bin, args) => spawnChildProcess(bin, args, {
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
}) as unknown as ReturnType<SpawnFn>;

const defaultSid = (helperPath: string, name: string): Promise<string> => new Promise((resolve, reject) => {
  const child = spawnChildProcess(helperPath, ['sid', name], { windowsHide: true });
  let out = '';
  child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
  child.on('error', reject);
  child.on('exit', (code) => { code === 0 ? resolve(out.trim()) : reject(new Error(`sandbox helper sid exit ${code}`)); });
});

/**
 * One sandbox per provider process. The container name is unique to it, so
 * its SID — and every ACE written for that SID — belongs to this window
 * alone. `dispose` is what makes grants temporary; without it an `icacls`
 * grant outlives the process, the window and a reboot.
 */
export async function createSandbox(cacheDir: string, deps: SandboxDeps = {}): Promise<Sandbox> {
  const helperPath = await (deps.build ?? buildHelper)(cacheDir);
  const deleteProfile = deps.deleteProfile
    ?? (async (n: string) => { spawnSync(helperPath, ['delete', n], { windowsHide: true }); });

  await sweepStale(cacheDir, { isAlive: deps.isAlive, revoke: deps.revoke, deleteProfile });

  const name = `marcode-codex-${process.pid}-${randomUUID().slice(0, 8)}`;
  const sid = await (deps.sid ?? defaultSid)(helperPath, name);
  const tracker = new GrantTracker(sid, { grant: deps.grant, revoke: deps.revoke });
  const getHomeDir = deps.homeDir ?? homedir;
  const doSpawn = deps.spawn ?? defaultSpawn;
  let homeGranted = false;

  const persist = () => writeRecord(cacheDir, { name, sid, pid: process.pid, folders: tracker.folders() });
  persist();

  return {
    name,

    async spawn(bin, args, cwd, opts = {}) {
      if (!homeGranted) {
        await tracker.grant(getHomeDir(), 'readonly');
        homeGranted = true;
      }
      if (opts.writable !== false) { await tracker.grant(cwd, 'readwrite'); }
      persist();

      const child = doSpawn(helperPath, ['run', name, cwd, bin, ...args]);
      let notify: (reason: string) => void = () => {};
      child.on('error', (err: unknown) => { notify(`sandbox helper failed to start (${(err as Error).message})`); });
      child.on('exit', (code: unknown, signal: unknown) => {
        notify(`sandboxed codex app-server exited (${(signal as string | null) ?? `code ${code}`})`);
      });
      return {
        stdin: child.stdin as never,
        stdout: child.stdout as never,
        kill: () => { child.kill(); },
        onFailure: (cb) => { notify = cb; },
      };
    },

    async grant(folder, mode) { await tracker.grant(folder, mode); persist(); },
    async revoke(folder) { await tracker.revoke(folder); persist(); },

    async dispose() {
      await tracker.revokeAll();
      await deleteProfile(name);
      removeRecord(cacheDir, name);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit:raw --grep "sweepStale|createSandbox"`
Expected: PASS (4 + 6 passing)

- [ ] **Step 5: Commit**

```bash
git add src/providers/codex/windows-sandbox/state.ts src/providers/codex/windows-sandbox/index.ts src/test/unit/windows-sandbox-state.test.ts src/test/unit/windows-sandbox-index.test.ts
git commit -m "feat: give each window its own sandbox that undoes its grants on dispose"
```

---

## Task 5: Platform branch in `codex-provider.ts` and `map-settings.ts`

**Files:**
- Modify: `src/providers/codex/codex-provider.ts:77-111` (`spawnAppServer`)
- Modify: `src/providers/codex/map-settings.ts:90-99` (`sandboxPolicyOf`)
- Test: `src/test/unit/codex-provider.test.ts`, `src/test/unit/codex-map-settings.test.ts`

**Interfaces:**
- Consumes: `createSandbox` / `Sandbox` (Task 4).
- Produces: no new exports; changes existing behavior only on `process.platform === 'win32'`.

- [ ] **Step 1: Write the failing test — `sandboxPolicyOf` always returns dangerFullAccess on win32**

```typescript
// added to src/test/unit/codex-map-settings.test.ts
test('every mode collapses to dangerFullAccess on win32 — enforcement moved to the AppContainer', () => {
  const modes: PermissionMode[] = ['default', 'auto', 'plan', 'dontAsk', 'bypass'];
  for (const mode of modes) {
    assert.deepStrictEqual(sandboxPolicyOf(mode, 'win32'), { type: 'dangerFullAccess' });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit:raw --grep "dangerFullAccess on win32"`
Expected: FAIL — `sandboxPolicyOf` takes one argument today, TS error / wrong result

- [ ] **Step 3: Update `sandboxPolicyOf`**

```typescript
// src/providers/codex/map-settings.ts — replace the existing function
export function sandboxPolicyOf(mode: PermissionMode, platform: NodeJS.Platform = process.platform): SandboxPolicy {
  if (platform === 'win32') {
    // Codex's own Windows sandbox blocks further child-process creation
    // outright (see the doc comment above), so on this platform enforcement
    // moves entirely into the AppContainer spawnAppServer runs under —
    // every PermissionMode collapses to dangerFullAccess here because
    // Codex is never the thing doing the sandboxing on Windows.
    return { type: 'dangerFullAccess' };
  }
  switch (codexSettings(mode).sandbox) {
    case 'danger-full-access': return { type: 'dangerFullAccess' };
    case 'read-only': return { type: 'readOnly', networkAccess: false };
    default: return {
      type: 'workspaceWrite', writableRoots: [], networkAccess: true,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    };
  }
}
```

- [ ] **Step 4: Run test, confirm pass; then write the failing spawn-path test**

Run: `yarn test:unit:raw --grep "dangerFullAccess on win32"` → PASS

```typescript
// added to src/test/unit/codex-provider.test.ts
test('on win32 the app-server spawns through the per-window sandbox, and teardown disposes it', async () => {
  const calls: string[] = [];
  const provider = new CodexProvider({
    binPath: 'codex.exe', platform: 'win32', sandboxCacheDir: 'C:\\cache',
    spawn: () => { throw new Error('must not be called — that would be the unsandboxed path'); },
    createSandbox: async () => ({
      name: 'marcode-codex-test',
      spawn: async (_bin: string, _args: string[], cwd: string) => { calls.push(`spawn:${cwd}`); return fakeDuplex(); },
      grant: async () => {}, revoke: async () => {},
      dispose: async () => { calls.push('dispose'); },
    }),
  });
  const run = provider.start({ cwd: 'C:\\work\\repo', /* ...other required StartOptions fields per existing tests... */ } as never);
  await run.dispose();   // last run gone -> ref-count zero -> teardown (after teardownGraceMs)
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(calls, ['spawn:C:\\work\\repo', 'dispose']);
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `yarn test:unit:raw --grep "per-window sandbox"`
Expected: FAIL — `CodexProvider` has no `platform`/`createSandbox`/`sandboxCacheDir` constructor option yet

- [ ] **Step 6: Wire the branch into `CodexProvider`**

```typescript
// src/providers/codex/codex-provider.ts — constructor options gain:
//   platform?: NodeJS.Platform;
//   createSandbox?: typeof import('./windows-sandbox').createSandbox;
//   sandboxCacheDir?: string;
// stored alongside the existing this.opts.spawn, defaulting platform to
// process.platform and createSandbox to a lazy `(await import('./windows-sandbox')).createSandbox`
// (lazy so macOS/Linux never touches the windows-sandbox module at all —
// see Review Focus: "non-win32 platforms importing windows-sandbox").
// The provider also gains `private sandbox?: Sandbox`.

// inside connect(), where `child = (this.opts.spawn ?? spawnAppServer)(bin, env)` lives today:
let child: Duplex;
try {
  if (this.opts.platform === 'win32') {
    const create = this.opts.createSandbox
      ?? (await import('./windows-sandbox')).createSandbox;
    this.sandbox = await create(this.sandboxCacheDir);
    child = await this.sandbox.spawn(bin, ['app-server'], this.cwdForSandbox, {
      writable: this.modeForSandbox !== 'plan',
    });
  } else {
    child = (this.opts.spawn ?? spawnAppServer)(bin, env);
  }
} catch {
  this.connectionPromise = undefined;
  // ...unchanged...
}
```

The full diff also needs `this.cwdForSandbox`/`this.modeForSandbox` populated from the first
thread's `cwd`/`PermissionMode` (or the workspace root Marcode already threads through
`StartOptions`) and `this.sandboxCacheDir` from a new constructor option sourced from
`context.globalStorageUri.fsPath` in `extension.ts` — thread these the same way `env`/`binPath`
already flow into the constructor at `extension.ts`'s provider construction site. A second thread
started later, in a different `cwd` and possibly a different mode, calls
`this.sandbox.grant(cwd, mode)` (Task 4) instead — each thread's own mode governs its own root's
write grant independently, and once any thread has write-granted a path it stays granted until the
shared `app-server` process is torn down, even if a later `plan`-mode thread reuses that same path.

**Teardown is where grants end.** Extend `teardown()` (`codex-provider.ts:521`, sync, called when
the last run releases the process or `setBinPath` drops it) so it also disposes the sandbox:

```typescript
private teardown(): void {
  const server = this.serverInstance;
  const sandbox = this.sandbox;
  this.connectionPromise = undefined;
  this.serverInstance = undefined;
  this.sandbox = undefined;
  server?.dispose();
  // Fire-and-forget: teardown is synchronous. A failed revoke is not lost —
  // the record file stays on disk and the next activation's sweep retries it.
  void sandbox?.dispose().catch(() => {});
}
```

A window that dies without reaching `teardown()` is exactly the crash case the startup sweep in
`createSandbox` exists for.

- [ ] **Step 7: Run test to verify it passes**

Run: `yarn test:unit:raw --grep "per-window sandbox"`
Expected: PASS

- [ ] **Step 8: Run the full unit suite**

Run: `yarn test:unit`
Expected: PASS, including the untouched macOS/Linux-path tests in `codex-provider.test.ts` and
`codex-run.test.ts` (`sandboxPolicyOf('plan')` without a platform argument must still default to
`process.platform`, i.e. behave exactly as before on the CI/dev machine's real platform).

- [ ] **Step 9: Commit**

```bash
git add src/providers/codex/codex-provider.ts src/providers/codex/map-settings.ts src/test/unit/codex-provider.test.ts src/test/unit/codex-map-settings.test.ts
git commit -m "feat: spawn Codex's app-server inside an AppContainer on Windows"
```

---

## Task 6: Probe-failure surfacing when AppContainer provisioning fails

**Files:**
- Modify: `src/providers/codex/codex-provider.ts` (the existing `connect()` catch branch)
- Test: `src/test/unit/codex-provider.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — confirms existing error-surfacing behavior extends to this failure mode.

- [ ] **Step 1: Write the failing test**

```typescript
// added to src/test/unit/codex-provider.test.ts
test('an AppContainer provisioning failure surfaces as a start() rejection, not a silent unsandboxed fallback', async () => {
  const provider = new CodexProvider({
    binPath: 'codex.exe',
    platform: 'win32', sandboxCacheDir: 'C:\\cache',
    createSandbox: async () => { throw new Error('CreateAppContainerProfile failed hr=0x80070005'); },
    spawn: () => { throw new Error('must not be called — that would be the unsandboxed fallback'); },
  });
  await assert.rejects(
    provider.start({ cwd: 'C:\\work\\repo' } as never),
    /CreateAppContainerProfile failed/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit:raw --grep "not a silent unsandboxed fallback"`
Expected: FAIL if the catch branch swallows the error instead of propagating it, or PASS already if
Task 5's `try`/`catch` already rethrows correctly — this task exists to pin that behavior with an
explicit test, per the "AppContainer provisioning failure is a probe failure" Global Constraint, not
necessarily to change code.

- [ ] **Step 3: Fix if needed**

If the existing catch branch (`this.connectionPromise = undefined;` then some recovery path) ends up
resolving instead of rejecting, change it to rethrow after clearing the cached promise — symmetric
with the existing spawn-failure and handshake-failure branches the doc comment above `connect()`
already describes.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit:raw --grep "not a silent unsandboxed fallback"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/providers/codex/codex-provider.ts src/test/unit/codex-provider.test.ts
git commit -m "test: pin AppContainer provisioning failure as a real start() rejection"
```

---

## Task 7: Spike — does Codex ask about out-of-root writes under `dangerFullAccess`?

This task gates the spec's "Out-of-root writes: ask, then grant" section. It writes no production
code; its deliverable is a recorded answer, and the implementation tasks for that section are
written **after** it, against the observed behavior rather than a guess.

**Files:**
- Create (scratch, not committed): a copy of `%TEMP%\codex-windows-sandbox-probe\probe.js`, which
  already speaks the real `initialize` / `thread/start` / `turn/start` wire shapes against the
  installed `codex.exe app-server`.
- Modify: `docs/superpowers/specs/2026-09-23-codex-windows-appcontainer-sandbox-design.md`
  ("Out-of-root writes: ask, then grant" — replace the "Open question" bullet with the result).

- [ ] **Step 1: Run the probe with the exact settings Marcode will send on win32**

`thread/start` with `sandbox: "danger-full-access"`, `approvalPolicy: "on-request"`,
`approvalsReviewer: "user"` (the `default` mode), `cwd` a throwaway git repo. Prompt the agent:
`Create a file named ../outside-probe.txt containing the word hello, using apply_patch.` Log every
server request and notification for the turn.

- [ ] **Step 2: Record which of two outcomes occurred**

- **A — the request arrives:** an `item/fileChange/requestApproval` server request names a path
  outside `cwd` before the file exists (check `Test-Path ..\outside-probe.txt` at the moment the
  request is parked). Implement the spec's pre-execution flow.
- **B — no request:** the file is simply written, or the turn ends with no server request.
  Implement the spec's reactive fallback (failed `fileChange` → card → grant → follow-up message).

Also record whether the `item/started` notification for the `fileChange` carries the target path
before the write lands, since the reactive flow reads its path from there or from the failed item.

- [ ] **Step 3: Write the result into the spec and commit it**

```bash
git add docs/superpowers/specs/2026-09-23-codex-windows-appcontainer-sandbox-design.md
git commit -m "docs: record whether codex asks about out-of-root writes under dangerFullAccess"
```

- [ ] **Step 4: Amend this plan with the implementation tasks**

Add Task 8 (the approval card, its three scopes — once / this session / always — and the
`Sandbox.grant`/`revoke` calls it makes) in the shape the recorded outcome dictates, using the
Task 1 tracker and Task 4 `Sandbox` interface already defined above. Do not start it before this
step: the two outcomes intercept at different points (`CodexRun`'s server-request handler vs. its
item-completed mapping) and share almost no code.

---

## Final verification

- [ ] `yarn lint`
- [ ] `yarn check-types`
- [ ] `yarn run compile`
- [ ] `yarn test:unit` (full suite; win32-gated tests only actually run on a Windows machine)
- [ ] On a real Windows machine: open a Codex session in Marcode, confirm `git switch`/`git status`
      and `bash -lc "git status"` inside the panel's shell-outs succeed under `default` mode (no more
      `bypass`-only workaround), and confirm `git fetch`/`push` against a real remote works
      (`internetClient` capability).
- [ ] Confirm a write attempted outside the session's `cwd` (e.g. asking the agent to touch a file
      elsewhere) is denied rather than silently succeeding — the one guarantee this design adds.
- [ ] Close the session (or reload the window), then run `icacls <workspace root>` and confirm no
      `marcode-codex-*` ACE remains; kill the extension host from Task Manager mid-session, reopen
      VS Code, and confirm the next activation's sweep removes the stale one.
- [ ] Confirm the session can still read `~/.codex` (skills/auth) and run a per-user-installed
      interpreter (e.g. `python --version` if one is on `PATH` under the profile, not just
      system-wide `Program Files`) — the broad-read grant this design depends on to avoid the
      home-directory-resolution failure found during design (`Could not find home directory`).
