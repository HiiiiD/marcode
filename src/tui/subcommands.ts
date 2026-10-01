import { spawn } from 'node:child_process';
import { configPath, seedConfigFileSafely } from '../host/config-file';
import type { HostConfig } from '../host/host-config';
import { importOldStorage } from '../host/migrate-storage';
import { marcodeHome, resolveWorkspaceDir } from '../host/workspace-dir';
import { bootHost } from './boot';
import { findGitRoot } from './workspace-root';

export interface SubIo {
  home?: string;
  out: (line: string) => void;
  err: (line: string) => void;
  spawn: (command: string, env: NodeJS.ProcessEnv) => Promise<number>;
  editor: () => string | undefined;
  bootConfig?: Partial<HostConfig>;
}

export const realIo: SubIo = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  spawn: (command, env) => new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: 'inherit', env });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  }),
  editor: () => process.env.VISUAL || process.env.EDITOR || undefined,
};

export async function runLogin(providerId: string, cwd: string, io: SubIo = realIo): Promise<number> {
  const booted = await bootHost({
    cwd, home: io.home, notify: io.err,
    config: { memory: { enabled: false, summarizer: undefined }, ...io.bootConfig },
  });
  try {
    const recipe = booted.host.loginRecipes.get(providerId);
    if (!recipe) {
      const known = [...booted.host.loginRecipes.keys()].join(', ') || 'none';
      io.err(`marcode: no sign-in flow for ${providerId}; known: ${known}`);
      return 1;
    }
    return await io.spawn(recipe.command, recipe.env);
  } finally {
    await booted.shutdown();
  }
}

export async function runConfig(io: SubIo = realIo): Promise<number> {
  const file = configPath(io.home ?? marcodeHome());
  const seeded = await seedConfigFileSafely(file, {});
  if (seeded.warning) { io.err(`marcode: ${seeded.warning}`); return 1; }
  const editor = io.editor();
  if (!editor) { io.out(file); return 0; }
  return io.spawn(`${editor} "${file}"`, process.env);
}

export async function runMigrate(oldDir: string, cwd: string, io: SubIo = realIo): Promise<number> {
  const dir = await resolveWorkspaceDir(io.home ?? marcodeHome(), await findGitRoot(cwd));
  const result = await importOldStorage(oldDir, dir);
  if (result.kind === 'failed') { io.err(`marcode: ${result.reason}`); return 1; }
  if (result.kind === 'none') { io.out(`nothing to import from ${oldDir}`); return 0; }
  io.out(`Imported ${result.sessions} session${result.sessions === 1 ? '' : 's'}`);
  return 0;
}
