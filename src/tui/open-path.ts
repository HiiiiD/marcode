import { spawn } from 'node:child_process';

export type Spawner = (cmd: string, args: string[]) => Promise<string | undefined>;

export function openCommand(path: string, platform: NodeJS.Platform): { cmd: string; args: string[] } {
  // Verbatim arguments, so the path is quoted here. The empty "" is `start`'s window-title slot, so a quoted path is not mistaken for it.
  if (platform === 'win32') { return { cmd: 'cmd', args: ['/c', 'start', '""', `"${path}"`] }; }
  if (platform === 'darwin') { return { cmd: 'open', args: [path] }; }
  return { cmd: 'xdg-open', args: [path] };
}

export const spawnDetached: Spawner = (cmd, args) => new Promise((resolve) => {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' });
    child.once('error', (err) => { resolve(err.message); });
    child.once('spawn', () => { child.unref(); resolve(undefined); });
  } catch (err) {
    resolve(err instanceof Error ? err.message : String(err));
  }
});

export async function openPath(path: string, spawner: Spawner = spawnDetached, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const { cmd, args } = openCommand(path, platform);
  const failure = await spawner(cmd, args);
  return failure === undefined ? undefined : `could not open ${path}: ${failure}`;
}
