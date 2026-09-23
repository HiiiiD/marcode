# Codex Windows AppContainer Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Codex's own broken Windows sandbox (`workspace-write`/`read-only`, which blocks
any shelled-out child process from spawning a further child) with one Marcode enforces itself: the
`app-server` process runs inside a Windows AppContainer, ACL-scoped to the workspace roots it needs,
so `git`/bash chains work and everything outside those roots is denied at the OS level — without
falling back to `danger-full-access` (no sandbox at all) as the only working Windows option.

**Architecture:** A compiled C# helper (`marcode-sandbox-helper.exe`, built once from source checked
into the repo via the OS-bundled `csc.exe`, cached under `globalStorageUri`) does the Win32 work
Node has no native binding for: derive/create an AppContainer SID, and launch a target process under
that container's security capability with `STARTUPINFOEX`, its stdio handles pointed straight at the
handles Node already piped to the helper (so the sandboxed grandchild talks directly to Node's pipes,
no relay copying), and a Job Object with `KILL_ON_JOB_CLOSE` so killing the helper always kills the
sandboxed process with it. A pure Node module (`acl.ts`) grants the container SID folder access via
`icacls`, the one part that needs no native call. `codex-provider.ts`'s `spawnAppServer` and
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
- Non-win32 platforms importing anything from `windows-sandbox/` at module-load time — the folder
  must be reachable only behind the `process.platform === 'win32'` branch, never imported
  unconditionally at the top of `codex-provider.ts` (Win32 API `DllImport` P/Invoke has no meaning
  off Windows, but more importantly a top-level import must not throw or behave oddly under macOS/
  Linux test runs).

---

## Task 1: Folder ACL grant/deny (`acl.ts`)

**Files:**
- Create: `src/providers/codex/windows-sandbox/acl.ts`
- Test: `src/test/unit/windows-sandbox-acl.test.ts`

**Interfaces:**
- Produces: `grantFolderAccess(sid: string, folder: string, mode: 'readwrite' | 'readonly', run?: ExecFn): Promise<void>` where `type ExecFn = (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>`, injected so the test never shells a real `icacls`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/test/unit/windows-sandbox-acl.test.ts
import * as assert from 'assert';
import { grantFolderAccess } from '../../providers/codex/windows-sandbox/acl';

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit:raw --grep grantFolderAccess`
Expected: FAIL — `Cannot find module '../../providers/codex/windows-sandbox/acl'`

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit:raw --grep grantFolderAccess`
Expected: PASS (3 passing)

- [ ] **Step 5: Commit**

```bash
git add src/providers/codex/windows-sandbox/acl.ts src/test/unit/windows-sandbox-acl.test.ts
git commit -m "feat: add icacls-backed AppContainer folder grant"
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

    static string ContainerName = "MarcodeCodexSandbox";

    static IntPtr EnsureSid()
    {
        IntPtr sid;
        int hr = CreateAppContainerProfile(ContainerName, "Marcode Codex Sandbox", "Scopes codex app-server to its workspace roots", IntPtr.Zero, 0, out sid);
        if (hr == unchecked((int)0x800700B7)) { DeriveAppContainerSidFromAppContainerName(ContainerName, out sid); }
        else if (hr != 0) { throw new Exception("CreateAppContainerProfile failed hr=0x" + hr.ToString("X8")); }
        return sid;
    }

    static int Main(string[] args)
    {
        if (args.Length < 1) { Console.Error.WriteLine("usage: sid | run <cwd> <exe> <args...>"); return 2; }

        if (args[0] == "sid")
        {
            IntPtr sid = EnsureSid();
            IntPtr strPtr; ConvertSidToStringSidW(sid, out strPtr);
            Console.WriteLine(Marshal.PtrToStringUni(strPtr));
            LocalFree(strPtr);
            return 0;
        }

        if (args[0] != "run" || args.Length < 3) { Console.Error.WriteLine("usage: run <cwd> <exe> <args...>"); return 2; }
        string cwd = args[1], exe = args[2];
        var cmd = new StringBuilder("\"" + exe + "\"");
        for (int i = 3; i < args.Length; i++) { cmd.Append(" \"" + args[i].Replace("\"", "\\\"") + "\""); }

        IntPtr sidHandle = EnsureSid();
        var secCap = new SECURITY_CAPABILITIES { AppContainerSid = sidHandle, Capabilities = IntPtr.Zero, CapabilityCount = 0 };
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
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { buildHelper } from '../../providers/codex/windows-sandbox/build-helper';
import { grantFolderAccess } from '../../providers/codex/windows-sandbox/acl';
import { shouldRunWindowsSandboxTests } from './windows-sandbox-helper-gate';

(shouldRunWindowsSandboxTests ? suite : suite.skip)('sandbox helper (real binary)', () => {
  test('spawns a nested child (cmd -> a marker file) inside the granted root, denies outside it', async function () {
    this.timeout(20000);
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'marcode-sandbox-cache-'));
    const helperPath = await buildHelper(cacheDir);

    const sid = await new Promise<string>((resolve, reject) => {
      const child = spawn(helperPath, ['sid'], { windowsHide: true });
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
      const child = spawn(helperPath, ['run', root, 'cmd.exe', '/c', path.join(root, 'run.cmd')], { windowsHide: true });
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
    const sid = await new Promise<string>((resolve, reject) => {
      const child = spawn(helperPath, ['sid'], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
      child.on('exit', (code) => { code === 0 ? resolve(out.trim()) : reject(new Error(`sid exit ${code}`)); });
    });

    const root = mkdtempSync(path.join(tmpdir(), 'marcode sandbox spaced root-'));
    await grantFolderAccess(sid, root, 'readwrite');
    const marker = path.join(root, 'inside.txt');
    writeFileSync(path.join(root, 'run.cmd'), `cmd /c echo hi > "${marker}"`);

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(helperPath, ['run', root, 'cmd.exe', '/c', path.join(root, 'run.cmd')], { windowsHide: true });
      child.on('exit', (code) => { code === null ? reject(new Error('killed')) : resolve(code); });
      child.on('error', reject);
    });

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(existsSync(marker), true, 'a spaced cwd/args path must reach CreateProcessW intact');
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

## Task 4: Node-facing spawn wrapper (`index.ts`)

**Files:**
- Create: `src/providers/codex/windows-sandbox/index.ts`
- Test: `src/test/unit/windows-sandbox-index.test.ts`

**Interfaces:**
- Consumes: `buildHelper` (Task 2), `grantFolderAccess` (Task 1), `Duplex` from
  `src/providers/codex/app-server.ts` (already defined: `{ stdin, stdout, kill(), onFailure(cb) }`,
  same shape `spawnAppServer` already returns — see `codex-provider.ts:105-110`).
- Produces: `spawnSandboxed(bin: string, args: string[], cwd: string, cacheDir: string, opts?: { spawn?: SpawnFn; build?: typeof buildHelper; grant?: typeof grantFolderAccess; sid?: (helperPath: string) => Promise<string> }): Promise<Duplex>`; `grantRoot(cwd: string, mode: 'readwrite' | 'readonly', cacheDir: string): Promise<void>` for the mid-lifetime new-`cwd` case.

- [ ] **Step 1: Write the failing test**

```typescript
// src/test/unit/windows-sandbox-index.test.ts
import * as assert from 'assert';
import { PassThrough } from 'node:stream';
import { spawnSandboxed } from '../../providers/codex/windows-sandbox/index';

suite('spawnSandboxed', () => {
  test('builds the helper, resolves the SID, grants the root, then launches "run" with it', async () => {
    const calls: string[] = [];
    const fakeChild = {
      stdin: new PassThrough(), stdout: new PassThrough(),
      kill: () => { calls.push('kill'); }, on: () => {}, pid: 123,
    };
    let spawnedArgs: string[] = [];
    const result = await spawnSandboxed('codex.exe', ['app-server'], 'C:\\work\\repo', 'C:\\cache', {
      build: async () => 'C:\\cache\\helper.exe',
      sid: async () => 'S-1-15-2-999',
      grant: async (sid, folder) => { calls.push(`grant:${sid}:${folder}`); },
      spawn: (bin, args) => { spawnedArgs = args; calls.push(`spawn:${bin}`); return fakeChild as never; },
    });

    assert.deepStrictEqual(calls, ['grant:S-1-15-2-999:C:\\work\\repo', 'spawn:C:\\cache\\helper.exe']);
    assert.deepStrictEqual(spawnedArgs, ['run', 'C:\\work\\repo', 'codex.exe', 'app-server']);
    assert.strictEqual(result.stdin, fakeChild.stdin);
    assert.strictEqual(result.stdout, fakeChild.stdout);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit:raw --grep spawnSandboxed`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/providers/codex/windows-sandbox/index.ts
import { spawn as spawnChildProcess } from 'node:child_process';
import type { Duplex } from '../app-server';
import { buildHelper } from './build-helper';
import { grantFolderAccess } from './acl';

type SpawnFn = (bin: string, args: string[]) => { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; kill(): void; on(event: string, cb: (...a: unknown[]) => void): void };

const defaultSpawn: SpawnFn = (bin, args) => spawnChildProcess(bin, args, {
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
}) as unknown as ReturnType<SpawnFn>;

async function sidOf(helperPath: string, run: SpawnFn = defaultSpawn): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = run(helperPath, ['sid']) as unknown as import('node:child_process').ChildProcess;
    let out = '';
    child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => { code === 0 ? resolve(out.trim()) : reject(new Error(`sandbox helper sid exit ${code}`)); });
  });
}

/**
 * Spawns `bin args...` inside a Marcode-controlled AppContainer scoped to
 * `cwd`, in place of a plain `child_process.spawn` — see the design doc for
 * why: codex's own Windows sandbox blocks further child-process creation
 * outright, this one doesn't, and unlike `danger-full-access` everything
 * outside the granted root stays denied.
 */
export async function spawnSandboxed(
  bin: string, args: string[], cwd: string, cacheDir: string,
  opts: { spawn?: SpawnFn; build?: typeof buildHelper; grant?: typeof grantFolderAccess; sid?: (helperPath: string) => Promise<string> } = {},
): Promise<Duplex> {
  const build = opts.build ?? buildHelper;
  const grant = opts.grant ?? grantFolderAccess;
  const doSpawn = opts.spawn ?? defaultSpawn;

  const helperPath = await build(cacheDir);
  const sid = opts.sid ? await opts.sid(helperPath) : await sidOf(helperPath, doSpawn);
  await grant(sid, cwd, 'readwrite');

  const child = doSpawn(helperPath, ['run', cwd, bin, ...args]);
  let notify: (reason: string) => void = () => {};
  child.on('error', (err: Error) => { notify(`sandbox helper failed to start (${err.message})`); });
  child.on('exit', (code: number | null, signal: string | null) => {
    notify(`sandboxed codex app-server exited (${signal ?? `code ${code}`})`);
  });

  return {
    stdin: child.stdin as never,
    stdout: child.stdout as never,
    kill: () => { child.kill(); },
    onFailure: (cb) => { notify = cb; },
  };
}

/** The mid-lifetime case: a newly seen thread `cwd` under an already-running app-server. */
export async function grantRoot(
  cwd: string, mode: 'readwrite' | 'readonly', cacheDir: string,
  opts: { build?: typeof buildHelper; grant?: typeof grantFolderAccess; sid?: (helperPath: string) => Promise<string> } = {},
): Promise<void> {
  const build = opts.build ?? buildHelper;
  const grant = opts.grant ?? grantFolderAccess;
  const helperPath = await build(cacheDir);
  const sid = opts.sid ? await opts.sid(helperPath) : await sidOf(helperPath);
  await grant(sid, cwd, mode);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit:raw --grep spawnSandboxed`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/providers/codex/windows-sandbox/index.ts src/test/unit/windows-sandbox-index.test.ts
git commit -m "feat: wire the AppContainer helper behind a spawnSandboxed seam"
```

---

## Task 5: Platform branch in `codex-provider.ts` and `map-settings.ts`

**Files:**
- Modify: `src/providers/codex/codex-provider.ts:77-111` (`spawnAppServer`)
- Modify: `src/providers/codex/map-settings.ts:90-99` (`sandboxPolicyOf`)
- Test: `src/test/unit/codex-provider.test.ts`, `src/test/unit/codex-map-settings.test.ts`

**Interfaces:**
- Consumes: `spawnSandboxed` (Task 4).
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
test('spawnAppServer uses spawnSandboxed on win32', async () => {
  let sandboxedArgs: unknown[] | undefined;
  const provider = new CodexProvider({
    binPath: 'codex.exe',
    spawn: undefined, // exercise the real branch inside spawnAppServer, not the injected seam
    platform: 'win32',
    spawnSandboxed: async (...args: unknown[]) => { sandboxedArgs = args; return fakeDuplex(); },
  });
  await provider.start({ cwd: 'C:\\work\\repo', /* ...other required StartOptions fields per existing tests... */ } as never);
  assert.ok(sandboxedArgs, 'spawnSandboxed should have been called instead of a plain child_process.spawn');
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `yarn test:unit:raw --grep "spawnSandboxed on win32"`
Expected: FAIL — `CodexProvider` has no `platform`/`spawnSandboxed` constructor option yet

- [ ] **Step 6: Wire the branch into `CodexProvider`**

```typescript
// src/providers/codex/codex-provider.ts — constructor options gain:
//   platform?: NodeJS.Platform;
//   spawnSandboxed?: typeof import('./windows-sandbox').spawnSandboxed;
//   sandboxCacheDir?: string;
// stored alongside the existing this.opts.spawn, defaulting platform to
// process.platform and spawnSandboxed to a lazy `require('./windows-sandbox').spawnSandboxed`
// (lazy so macOS/Linux never touches the windows-sandbox module at all —
// see Review Focus: "non-win32 platforms importing windows-sandbox").

// inside connect(), where `child = (this.opts.spawn ?? spawnAppServer)(bin, env)` lives today:
let child: Duplex;
try {
  if (this.opts.platform === 'win32') {
    const sandboxed = this.opts.spawnSandboxed
      ?? (await import('./windows-sandbox')).spawnSandboxed;
    child = await sandboxed(bin, ['app-server'], this.cwdForSandbox, this.sandboxCacheDir, {});
  } else {
    child = (this.opts.spawn ?? spawnAppServer)(bin, env);
  }
} catch {
  this.connectionPromise = undefined;
  // ...unchanged...
}
```

The full diff also needs `this.cwdForSandbox` populated from the first thread's `cwd` (or the
workspace root Marcode already threads through `StartOptions`) and `this.sandboxCacheDir` from a
new constructor option sourced from `context.globalStorageUri.fsPath` in `extension.ts` — thread
these the same way `env`/`binPath` already flow into the constructor at `extension.ts`'s provider
construction site.

- [ ] **Step 7: Run test to verify it passes**

Run: `yarn test:unit:raw --grep "spawnSandboxed on win32"`
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
    platform: 'win32',
    spawnSandboxed: async () => { throw new Error('CreateAppContainerProfile failed hr=0x80070005'); },
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

## Final verification

- [ ] `yarn lint`
- [ ] `yarn check-types`
- [ ] `yarn run compile`
- [ ] `yarn test:unit` (full suite; win32-gated tests only actually run on a Windows machine)
- [ ] On a real Windows machine: open a Codex session in Marcode, confirm `git switch`/`git status`
      inside the panel's shell-outs succeed under `default` mode (no more `bypass`-only workaround),
      and confirm a write attempted outside the session's `cwd` (e.g. asking the agent to touch a
      file elsewhere) is denied rather than silently succeeding.
