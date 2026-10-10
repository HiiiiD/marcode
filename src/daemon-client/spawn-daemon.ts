import { spawn, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface Runtime { execPath: string; argv1: string | undefined }

const current = (): Runtime => ({ execPath: process.execPath, argv1: process.argv[1] });
const isBun = (execPath: string): boolean => /^bun(\.exe)?$/i.test(path.basename(execPath));

/** A Bun script re-runs its own entry; a compiled binary is its own entry. */
export function daemonSpawnCommand(
  workspaceDir: string,
  roots: string[],
  runtime: Runtime = current(),
  extension?: { script: string },
): { command: string; args: string[]; env?: Record<string, string> } {
  const tail = ['daemon', '--serve', '--workspace-dir', workspaceDir, ...roots.flatMap((r) => ['--root', r])];
  if (extension) {
    return { command: runtime.execPath, args: [extension.script, ...tail], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return isBun(runtime.execPath) && runtime.argv1
    ? { command: runtime.execPath, args: [runtime.argv1, ...tail] }
    : { command: runtime.execPath, args: tail };
}

// cwd: a detached daemon must not pin the client's directory (Windows refuses to remove a process's cwd).
export const daemonSpawnOptions = (workspaceDir: string, log: number): SpawnOptions => ({
  cwd: workspaceDir, detached: true, stdio: ['ignore', log, log], windowsHide: true,
});

export async function spawnDetached(workspaceDir: string, roots: string[], extension?: { script: string }): Promise<void> {
  const { command, args, env } = daemonSpawnCommand(workspaceDir, roots, current(), extension);
  await fs.promises.mkdir(workspaceDir, { recursive: true });
  const log = fs.openSync(path.join(workspaceDir, 'daemon.log'), 'a');
  try {
    const child = spawn(command, args, { ...daemonSpawnOptions(workspaceDir, log), ...(env ? { env: { ...process.env, ...env } } : {}) });
    child.on('error', (err) => { console.error('[marcode] daemon spawn failed', err); });
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}
