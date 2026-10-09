import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { format } from 'node:util';
import { readDaemonInfo } from '../daemon/daemon-info';
import { requestShutdown } from '../daemon/request-shutdown';
import { runDaemon } from '../daemon/run-daemon';
import { configPath, loadConfig, seedConfigFileSafely } from '../host/config-file';
import { defaultHostConfig, type HostConfig } from '../host/host-config';
import { defaultLeaseDeps } from '../host/lease';
import { importOldStorage } from '../host/migrate-storage';
import { marcodeHome, resolveWorkspaceDir } from '../host/workspace-dir';
import { bootHost } from './boot';
import type { CliCommand } from './cli';
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

// require, not import: package.json sits outside rootDir, and both tsx and bun resolve it at runtime.
const APP_VERSION = (require('../../package.json') as { version: string }).version;

type DaemonCommand = Extract<CliCommand, { kind: 'daemon' }>;

export async function runDaemonCommand(cmd: DaemonCommand, cwd: string, io: SubIo = realIo): Promise<number> {
  const home = io.home ?? marcodeHome();
  if (cmd.action === 'serve') { return serveDaemon(cmd.workspaceDir as string, cmd.roots, home, io); }
  const dir = await resolveWorkspaceDir(home, await findGitRoot(cwd));
  const info = await readDaemonInfo(dir);
  if (!info || !defaultLeaseDeps.pidAlive(info.pid)) {
    io.out('not running');
    return cmd.action === 'status' ? 1 : 0;
  }
  if (cmd.action === 'status') {
    io.out(`running pid=${info.pid} protocol=${info.protocolVersion} started=${new Date(info.startedAt).toISOString()}`);
    return 0;
  }
  const answer = await requestShutdown(info.endpoint, info.token);
  if (answer === 'bye') { io.out('stopped'); return 0; }
  io.err(answer === 'unreachable' ? 'unreachable' : `refused: ${answer}`);
  return 1;
}

async function serveDaemon(workspaceDir: string, roots: string[], home: string, io: SubIo): Promise<number> {
  fs.mkdirSync(workspaceDir, { recursive: true });
  const logFile = path.join(workspaceDir, 'daemon.log');
  const log = (line: string) => {
    try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}
`); } catch { /* a log that cannot be written must not stop the daemon */ }
  };
  // Detached with stdio ignored: the server's and host's console diagnostics would otherwise vanish.
  console.error = console.warn = (...args: unknown[]) => log(format(...args));
  const loaded = await loadConfig(configPath(home));
  for (const w of loaded.warnings) { log(w); }
  const config: HostConfig = { ...defaultHostConfig(), ...loaded.config, ...io.bootConfig };
  const daemon = await runDaemon({ workspaceDir, config, appVersion: APP_VERSION, initialRoots: roots, log });
  const onSignal = () => { void daemon.stop(); };
  const onCrash = (err: unknown) => {
    log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exitCode = 1;
    void daemon.stop();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  try {
    await daemon.done;
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
  }
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}
