import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResolvedShell } from './shell-aliases';

export interface ShellResult {
  exitCode?: number; signal?: string; truncated?: boolean; timedOut?: boolean; cancelled?: boolean; error?: string;
}
export interface ShellRunHandle { cancel(): void; done: Promise<ShellResult> }
export interface ShellRunOptions {
  cwd: string; spec: ResolvedShell;
  timeoutMs?: number; maxOutput?: number; flushMs?: number; graceMs?: number;
  bashPath?: () => string | undefined;
}

export const OUTPUT_CAP = 64 * 1024;
export const WALL_TIMEOUT_MS = 120_000;
const NO_BASH = 'No bash found. Install Git for Windows, or add a "shell.aliases" entry (for example pwsh) in config.json.';

export function findBash(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = fs.existsSync,
): string | undefined {
  if (platform !== 'win32') { return 'bash'; }
  const p = path.win32;
  for (const dir of (env.PATH ?? env.Path ?? '').split(p.delimiter).filter(Boolean)) {
    // System32\bash.exe is the WSL launcher, not Git Bash.
    if (/[\\/]system32[\\/]*$/i.test(dir)) { continue; }
    const candidate = p.join(dir, 'bash.exe');
    if (exists(candidate)) { return candidate; }
  }
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Programs')];
  for (const root of roots) {
    if (!root) { continue; }
    const candidate = p.join(root, 'Git', 'bin', 'bash.exe');
    if (exists(candidate)) { return candidate; }
  }
  return undefined;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) { return; }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

export function runShell(opts: ShellRunOptions, onUpdate: (output: string, truncated: boolean) => void): ShellRunHandle {
  const cap = opts.maxOutput ?? OUTPUT_CAP;
  const flushMs = opts.flushMs ?? 250;
  const graceMs = opts.graceMs ?? 500;
  let cancelFn = () => {};
  const done = new Promise<ShellResult>((resolve) => {
    let file: string; let args: string[];
    if (opts.spec.kind === 'alias') {
      file = opts.spec.file; args = opts.spec.args;
    } else {
      const bash = (opts.bashPath ?? (() => findBash()))();
      if (!bash) { resolve({ error: NO_BASH }); return; }
      file = bash; args = ['-c', opts.spec.script];
    }
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      });
    } catch (err) { resolve({ error: err instanceof Error ? err.message : String(err) }); return; }

    let output = ''; let truncated = false; let timedOut = false; let cancelled = false; let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => { timer = undefined; onUpdate(output, truncated); };
    const take = (chunk: string) => {
      output += chunk;
      if (output.length > cap) { output = output.slice(-cap); truncated = true; }
      timer ??= setTimeout(flush, flushMs);
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', take);
    }
    // A backgrounded grandchild can hold the pipes open after the shell is gone (and on Windows taskkill cannot
    // reach it once its parent has exited), so `close` alone may never fire. Past the grace the streams are cut.
    let exit: ShellResult | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const forceFinish = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(exit ?? {});
    };
    const armGrace = () => { graceTimer ??= setTimeout(forceFinish, graceMs); };
    const stop = () => { killTree(child); armGrace(); };
    const wall = setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs ?? WALL_TIMEOUT_MS);
    cancelFn = () => { cancelled = true; stop(); };
    const finish = (result: ShellResult) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(wall);
      clearTimeout(graceTimer);
      if (timer) { clearTimeout(timer); }
      onUpdate(output, truncated);
      resolve({ ...result, ...(truncated ? { truncated } : {}), ...(timedOut ? { timedOut } : {}), ...(cancelled ? { cancelled } : {}) });
    };
    child.on('error', (err) => finish({ error: err.message }));
    child.on('exit', (code, signal) => {
      exit = { ...(code !== null ? { exitCode: code } : {}), ...(signal ? { signal } : {}) };
      armGrace();
    });
    child.on('close', (code, signal) => finish({
      ...(code !== null ? { exitCode: code } : {}), ...(signal ? { signal } : {}),
    }));
  });
  return { cancel: () => cancelFn(), done };
}
