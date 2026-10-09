import { spawn } from 'node:child_process';
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
): { command: string; args: string[] } {
  const tail = ['daemon', '--serve', '--workspace-dir', workspaceDir, ...roots.flatMap((r) => ['--root', r])];
  return isBun(runtime.execPath) && runtime.argv1
    ? { command: runtime.execPath, args: [runtime.argv1, ...tail] }
    : { command: runtime.execPath, args: tail };
}

export async function spawnDetached(workspaceDir: string, roots: string[]): Promise<void> {
  const { command, args } = daemonSpawnCommand(workspaceDir, roots);
  await fs.promises.mkdir(workspaceDir, { recursive: true });
  const log = fs.openSync(path.join(workspaceDir, 'daemon.log'), 'a');
  try {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.on('error', (err) => { console.error('[marcode] daemon spawn failed', err); });
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}
