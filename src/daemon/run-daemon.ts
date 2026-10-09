import { createHost, type HostHandle } from '../host/create-host';
import type { HostConfig } from '../host/host-config';
import { defaultLeaseDeps } from '../host/lease';
import { MessageRouter } from '../host/message-router';
import { PostBus } from '../host/post-bus';
import type { HostToWebview } from '../protocol/messages';
import { DaemonServer } from './daemon-server';
import { newToken, readDaemonInfo, removeDaemonInfo, writeDaemonInfo, type DaemonInfo } from './daemon-info';
import { endpointFor } from './endpoint';
import { IdleMonitor, isBusy } from './idle-monitor';
import { toLoginRecipesWire } from './login-recipes';
import { PROTOCOL_VERSION } from './protocol';

export interface RunDaemonOptions {
  workspaceDir: string;
  config: HostConfig;
  appVersion: string;
  initialRoots: string[];
  idleMsOverride?: number;
  /** Test seam: the version advertised in daemon.json and required at hello. */
  protocolVersionOverride?: number;
  log?: (line: string) => void;
  /** Test seam: the host, once built, so a test can move a session without a client attached. */
  onHost?: (host: HostHandle) => void;
}

const errorText = (err: unknown) => (err instanceof Error ? err.stack ?? err.message : String(err));

export interface RunningDaemon { info: DaemonInfo; done: Promise<void>; stop(): Promise<void> }

export async function runDaemon(opts: RunDaemonOptions): Promise<RunningDaemon> {
  const { workspaceDir, config } = opts;
  const log = opts.log ?? (() => {});
  const bus = new PostBus();
  const identity = { protocolVersion: opts.protocolVersionOverride ?? PROTOCOL_VERSION, appVersion: opts.appVersion };
  const token = newToken();
  const endpoint = endpointFor(workspaceDir);
  let stopped = false;
  let monitor: IdleMonitor | undefined;
  let server: DaemonServer | undefined;
  const check = () => { if (!stopped) { monitor?.check(); } };

  // On POSIX, listen() unlinks the socket path first, which would orphan a live daemon's clients.
  const existing = await readDaemonInfo(workspaceDir);
  if (existing && existing.pid !== process.pid && defaultLeaseDeps.pidAlive(existing.pid)) {
    const message = `a daemon is already running for this workspace (pid ${existing.pid})`;
    log(`startup failed: ${message}`);
    throw new Error(message);
  }

  let host: HostHandle;
  try {
    host = await createHost({
      workspaceDir, config, hostKind: 'daemon',
      workspaceRoots: () => (server?.roots().length ? server.roots() : opts.initialRoots),
      emit: (m: HostToWebview) => { bus.post(m); if (m.t === 'session-status') { check(); } },
      notify: { warn: log },
    });
  } catch (err) {
    log(`startup failed: ${errorText(err)}`);
    throw err;
  }
  opts.onHost?.(host);

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => (stopping ??= (async () => {
    stopped = true;
    monitor?.dispose();
    try {
      await server?.close();
      await host.dispose();
      await removeDaemonInfo(workspaceDir, process.pid);
    } catch (err) {
      log(`stop failed: ${errorText(err)}`);
    } finally {
      log('stopped');
      resolveDone();
    }
  })());

  let favorites = config.favoriteModels;
  try {
    await host.init();
    server = new DaemonServer({
      endpoint, bus, startupRoots: [],
      connectionDeps: {
        token, identity,
        loginRecipes: toLoginRecipesWire(host.loginRecipes),
        isBusy: () => isBusy(host.manager.summaries()),
        makeRouter: (emit, hooks, hello) => new MessageRouter(
          host.manager, emit, hello.defaultCwd, hooks.editor, host.attachments, hooks.picker,
          config.review.pollIntervalMs, hooks.fileSearch, favorites,
          { setFavoriteModels: (ids) => { favorites = ids; hooks.configHost.setFavoriteModels(ids); } },
        ),
        onShutdown: () => { log('shutdown requested'); void stop(); },
        onChange: check,
      },
    });
    await server.listen();
  } catch (err) {
    log(`startup failed: ${errorText(err)}`);
    await stop();
    throw err;
  }

  const info: DaemonInfo = { pid: process.pid, endpoint, token, ...identity, startedAt: Date.now() };
  try {
    await writeDaemonInfo(workspaceDir, info);
  } catch (err) {
    log(`startup failed: ${errorText(err)}`);
    await stop();
    throw err;
  }
  // A shutdown that landed while daemon.json was being written already ran its removal.
  if (stopped) {
    await stop();
    await removeDaemonInfo(workspaceDir, process.pid);
    return { info, done, stop };
  }
  const live = server;
  monitor = new IdleMonitor({
    busy: () => isBusy(host.manager.summaries()),
    clients: () => live.clientCount(),
    idleMs: opts.idleMsOverride ?? config.daemon.idleMinutes * 60_000,
    onIdle: () => { log('idle; exiting'); void stop(); },
  });
  log(`listening on ${endpoint} (pid ${process.pid})`);
  check();
  return { info, done, stop };
}
