import { configPath, favoriteModelsSource, loadConfig } from '../host/config-file';
import { createHost, type HostHandle } from '../host/create-host';
import { defaultHostConfig, type HostConfig } from '../host/host-config';
import { MessageRouter } from '../host/message-router';
import { createTerminalFileIndex } from '../host/terminal-file-index';
import { marcodeHome, resolveWorkspaceDir } from '../host/workspace-dir';
import { createLoopback, type Loopback } from '../client-core/loopback-transport';
import { terminalConfigHost, terminalEditorHost } from './tui-hooks';
import { findGitRoot } from './workspace-root';

export interface BootOptions {
  cwd: string;
  home?: string;
  config?: Partial<HostConfig>;
  notify?: (message: string) => void;
}

export interface Booted {
  host: HostHandle;
  router: MessageRouter;
  loopback: Loopback;
  workspaceRoot: string;
  launchCwd: string;
  configFile: string;
  /** What config.json said, before boot overrides; the baseline a config watch compares against. */
  fileConfig: HostConfig;
  warnings: string[];
  shutdown(): Promise<void>;
}

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

  let router: MessageRouter | undefined;
  const loopback = createLoopback((msg) => router?.handle(msg));
  const host = await createHost({
    workspaceDir, config, hostKind: 'tui',
    workspaceRoots: () => [workspaceRoot],
    emit: (msg) => loopback.deliver(msg),
    notify: { warn },
  });
  try {
    await host.init();

    const favorites = favoriteModelsSource(configFile, config.favoriteModels, warn);
    router = new MessageRouter(
      host.manager, (msg) => loopback.deliver(msg), opts.cwd,
      terminalEditorHost(() => {}), host.attachments, undefined, config.review.pollIntervalMs,
      createTerminalFileIndex(workspaceRoot), favorites.get(), terminalConfigHost((ids) => { void favorites.set(ids); }),
    );
  } catch (err) {
    await host.dispose().catch(() => {});
    throw err;
  }

  let down: Promise<void> | undefined;
  return {
    host, router, loopback, workspaceRoot, launchCwd: opts.cwd, configFile, fileConfig: loaded.config, warnings,
    shutdown: () => (down ??= host.dispose()),
  };
}
