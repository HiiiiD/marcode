import * as fs from 'node:fs/promises';
import type { ClientTransport } from '../client-core/transport';
import { createLoopback, type Loopback } from '../client-core/loopback-transport';
import { PROTOCOL_VERSION } from '../daemon/protocol';
import { connectOrSpawn } from '../daemon-client/connect-or-spawn';
import type { ClientHooks, ClientStatus, DaemonClient } from '../daemon-client/daemon-client';
import { spawnDetached } from '../daemon-client/spawn-daemon';
import { configPath, favoriteModelsSource, loadConfig } from '../host/config-file';
import { createHost, type HostHandle, type LoginRecipe } from '../host/create-host';
import { defaultHostConfig, type HostConfig } from '../host/host-config';
import { MessageRouter } from '../host/message-router';
import { createTerminalFileIndex } from '../host/terminal-file-index';
import { marcodeHome, resolveWorkspaceDir } from '../host/workspace-dir';
import { APP_VERSION } from '../shared/app-version';
import { requestAttachmentPath } from './attachment-request';
import { openPath } from './open-path';
import { terminalConfigHost, terminalEditorHost } from './tui-hooks';
import { findGitRoot } from './workspace-root';

export interface BootOptions {
  cwd: string;
  home?: string;
  config?: Partial<HostConfig>;
  notify?: (message: string) => void;
  /** Skip the daemon: a short-lived command that must not leave a background host behind. */
  inProcess?: boolean;
  /** Test seam for how a missing daemon is started. */
  spawnDaemon?: (workspaceDir: string, roots: string[]) => Promise<void>;
}

interface BootedBase {
  loginRecipes: Map<string, LoginRecipe>;
  workspaceRoot: string;
  launchCwd: string;
  configFile: string;
  /** What config.json said, before boot overrides; the baseline a config watch compares against. */
  fileConfig: HostConfig;
  warnings: string[];
  fallbackReason?: string;
  onStatus(cb: (s: ClientStatus) => void): () => void;
  shutdown(): Promise<void>;
}

export interface InProcessBooted extends BootedBase {
  mode: 'in-process';
  host: HostHandle;
  router: MessageRouter;
  loopback: Loopback;
}

export interface DaemonBooted extends BootedBase {
  mode: 'daemon';
  host?: undefined;
  router?: undefined;
  loopback: { transport: ClientTransport };
}

export type Booted = InProcessBooted | DaemonBooted;

type Favorites = ReturnType<typeof favoriteModelsSource>;
type FileIndex = ReturnType<typeof createTerminalFileIndex>;
type Base = Omit<BootedBase, 'loginRecipes' | 'onStatus' | 'shutdown'>;

export async function bootHost(opts: BootOptions): Promise<Booted> {
  const home = opts.home ?? marcodeHome();
  const configFile = configPath(home);
  const warnings: string[] = [];
  const warn = (message: string) => { warnings.push(message); (opts.notify ?? console.error)(message); };

  const loaded = await loadConfig(configFile);
  for (const w of loaded.warnings) { warn(w); }
  const config: HostConfig = { ...defaultHostConfig(), ...loaded.config, ...opts.config };

  const workspaceRoot = await findGitRoot(opts.cwd);
  const workspaceDir = await resolveWorkspaceDir(home, workspaceRoot);
  const favorites = favoriteModelsSource(configFile, config.favoriteModels, warn);
  const base: Base = { workspaceRoot, launchCwd: opts.cwd, configFile, fileConfig: loaded.config, warnings };

  if (!opts.inProcess && config.daemon.enabled) {
    const fileIndex = createTerminalFileIndex(workspaceRoot);
    const spawn = opts.spawnDaemon ?? spawnDetached;
    const r = await connectOrSpawn({
      workspaceDir, clientKind: 'tui', roots: [workspaceRoot], defaultCwd: opts.cwd,
      identity: { protocolVersion: PROTOCOL_VERSION, appVersion: APP_VERSION },
      hooks: daemonHooks(fileIndex, favorites),
      spawn: async () => {
        await fs.mkdir(workspaceDir, { recursive: true });
        await spawn(workspaceDir, [workspaceRoot]);
      },
    });
    if (r.kind === 'attached') { return daemonBooted(r.client, fileIndex, base, warn); }
    await fileIndex.dispose();
    warn(`Running without the background host: ${r.message}`);
    base.fallbackReason = r.reason;
  }
  return inProcessBooted(opts, config, workspaceDir, favorites, base, warn);
}

function daemonHooks(fileIndex: FileIndex, favorites: Favorites): ClientHooks {
  const editor = terminalEditorHost(() => {});
  return {
    context: () => null,
    act: (op, args) => {
      if (op === 'setFavoriteModels') { void favorites.set(args[0] as string[]); return; }
      (editor[op] as (...a: unknown[]) => void)(...args);
    },
    // The TUI has no file picker; an empty pick is what the in-process router's missing picker yields too.
    ask: async (op, args) => (op === 'search' ? fileIndex.search(String(args[0] ?? '')) : []),
  };
}

function daemonBooted(client: DaemonClient, fileIndex: FileIndex, base: Base, warn: (m: string) => void): DaemonBooted {
  const openAttachment = async (ref: { id: string; attachmentId: string; itemId?: string }) => {
    const path = await requestAttachmentPath(client, ref);
    const failure = path ? await openPath(path) : 'attachment not found';
    if (failure) { warn(failure); }
  };
  const transport: ClientTransport = {
    post: (msg) => {
      if (msg.t === 'open-attachment') { void openAttachment(msg).catch((err: unknown) => warn(String(err))); return; }
      client.post(msg);
    },
    onMessage: (listener) => client.onMessage(listener),
  };
  const loginRecipes = new Map(client.loginRecipes.map((r): [string, LoginRecipe] => [
    r.id, { terminalName: r.terminalName, command: r.command, env: { ...process.env, ...r.env } },
  ]));
  let down: Promise<void> | undefined;
  return {
    ...base, mode: 'daemon', loopback: { transport }, loginRecipes,
    onStatus: (cb) => client.onStatus(cb),
    // Closing the link only: the daemon and any running turn outlive this client by design.
    shutdown: () => (down ??= (async () => { client.close(); await fileIndex.dispose(); })()),
  };
}

async function inProcessBooted(
  opts: BootOptions, config: HostConfig, workspaceDir: string, favorites: Favorites, base: Base, warn: (m: string) => void,
): Promise<InProcessBooted> {
  const { workspaceRoot } = base;
  let router: MessageRouter | undefined;
  let fileIndex: FileIndex | undefined;
  const loopback = createLoopback(async (msg) => {
    if (msg.t === 'open-attachment') {
      const path = await host?.manager.attachmentPath(msg.id, msg.attachmentId, msg.itemId);
      const failure = path ? await openPath(path) : 'attachment not found';
      if (failure) { warn(failure); }
      return;
    }
    return router?.handle(msg);
  });
  const host = await createHost({
    workspaceDir, config, hostKind: 'tui',
    workspaceRoots: () => [workspaceRoot],
    emit: (msg) => loopback.deliver(msg),
    notify: { warn },
  });
  try {
    await host.init();
    fileIndex = createTerminalFileIndex(workspaceRoot);
    router = new MessageRouter(
      host.manager, (msg) => loopback.deliver(msg), opts.cwd,
      terminalEditorHost(() => {}), host.attachments, undefined, config.review.pollIntervalMs,
      fileIndex, favorites.get(), terminalConfigHost((ids) => { void favorites.set(ids); }),
    );
  } catch (err) {
    await Promise.all([fileIndex?.dispose(), host.dispose()]).catch(() => {});
    throw err;
  }

  const index = fileIndex;
  let down: Promise<void> | undefined;
  return {
    ...base, mode: 'in-process', host, router, loopback, loginRecipes: host.loginRecipes,
    onStatus: () => () => {},
    shutdown: () => (down ??= Promise.all([index.dispose(), host.dispose()]).then(() => undefined)),
  };
}
