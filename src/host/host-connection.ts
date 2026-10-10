import * as path from 'node:path';
import { PROTOCOL_VERSION } from '../daemon/protocol';
import { connectOrSpawn as realConnectOrSpawn, type ConnectOptions } from '../daemon-client/connect-or-spawn';
import type { ClientStatus, DaemonClient } from '../daemon-client/daemon-client';
import type { ClientKind } from '../protocol/daemon-wire';
import { APP_VERSION } from '../shared/app-version';
import { hooksToClient, type HookSet, type Notices } from './act-adapter';
import { createHost as realCreateHost, type HostHandle, type LoginRecipe } from './create-host';
import type { HostConfig } from './host-config';
import { createInProcessLink } from './in-process-link';
import type { UpdateNotifyHost } from './message-router';
import { PostBus } from './post-bus';
import type { HostConnection, SurfaceLink } from './surface-link';

export interface HostConnectionDeps {
  workspaceDir: string;
  config: HostConfig;
  roots: () => string[];
  defaultCwd: string;
  /** reloadSignature of the config.json this window loaded. */
  configSignature: string;
  hooks: HookSet & { updateNotify: UpdateNotifyHost };
  notices: Notices;
  showCacheTimer: boolean;
  favoriteModels: () => string[];
  /** Editor context for the sidebar; other surfaces send none. */
  context: () => unknown;
  spawn(workspaceDir: string, roots: string[]): Promise<void>;
  connectOrSpawn?: typeof realConnectOrSpawn;
  createHost?: typeof realCreateHost;
}

type OptionsFor = (kind: ClientKind, first: boolean) => ConnectOptions;

const deadLink = (): SurfaceLink => ({
  transport: { post: () => {}, onMessage: () => () => {} },
  onStatus: (cb: (s: ClientStatus) => void) => { queueMicrotask(() => cb('lost')); return () => {}; },
  status: () => 'lost',
  pushContext: () => {},
  dispose: () => {},
});

function daemonLink(client: DaemonClient, initial: ClientStatus, forget: () => void): SurfaceLink {
  let closed = false;
  let status = initial;
  const offStatus = client.onStatus((s) => { status = s; });
  return {
    transport: client,
    onStatus: (cb) => client.onStatus(cb),
    status: () => status,
    pushContext: (ctx) => client.pushContext(ctx),
    dispose: () => { if (!closed) { closed = true; offStatus(); client.close(); forget(); } },
  };
}

export async function openHostConnection(deps: HostConnectionDeps): Promise<HostConnection> {
  const attachmentsBaseDir = path.join(deps.workspaceDir, 'attachments');
  let fallbackNotice: string | undefined;

  if (deps.config.daemon.enabled) {
    const options: OptionsFor = (kind, first) => ({
      workspaceDir: deps.workspaceDir, clientKind: kind, roots: deps.roots(), defaultCwd: deps.defaultCwd,
      identity: { protocolVersion: PROTOCOL_VERSION, appVersion: APP_VERSION },
      hooks: { ...hooksToClient(deps.hooks, deps.notices), context: kind === 'sidebar' ? deps.context : () => null },
      spawn: () => deps.spawn(deps.workspaceDir, deps.roots()),
      ...(first ? { configSignature: deps.configSignature, replaceOlderBuild: true } : {}),
    });
    const connect = deps.connectOrSpawn ?? realConnectOrSpawn;
    const first = await connect(options('sidebar', true));
    if (first.kind === 'attached') {
      return daemonConnection(deps, options, first.client, first.warnings ?? [], attachmentsBaseDir);
    }
    fallbackNotice = `Running without the background host: ${first.message}`;
  }
  return inProcessConnection(deps, fallbackNotice, attachmentsBaseDir);
}

function daemonConnection(
  deps: HostConnectionDeps, options: OptionsFor, firstClient: DaemonClient, warnings: string[], attachmentsBaseDir: string,
): HostConnection {
  const links = new Set<SurfaceLink>();
  let disposed = false;
  let held: DaemonClient | undefined = firstClient;
  // The sidebar may open long after activation; by then this client can already be reconnecting or lost.
  let heldStatus: ClientStatus = 'connected';
  const offHeld = firstClient.onStatus((s) => { heldStatus = s; });
  const recipes = new Map<string, LoginRecipe>(firstClient.loginRecipes.map((r): [string, LoginRecipe] => [
    r.id, { terminalName: r.terminalName, command: r.command, env: { ...process.env, ...r.env } },
  ]));
  const track = (client: DaemonClient, status: ClientStatus = 'connected'): SurfaceLink => {
    const link: SurfaceLink = daemonLink(client, status, () => links.delete(link));
    links.add(link);
    return link;
  };
  const connect = deps.connectOrSpawn ?? realConnectOrSpawn;
  return {
    mode: 'daemon', fallbackNotice: undefined, warnings, loginRecipes: recipes, attachmentsBaseDir,
    connect: async (kind) => {
      if (disposed) { return deadLink(); }
      if (kind === 'sidebar' && held) {
        const client = held;
        held = undefined;
        offHeld();
        if (heldStatus === 'connected') { return track(client); }
        client.close();
      }
      try {
        const r = await connect(options(kind, false));
        if (r.kind !== 'attached') { return deadLink(); }
        if (disposed) { r.client.close(); return deadLink(); }
        return track(r.client);
      } catch (err) {
        console.error('[mar-code] could not connect a surface to the background host', err);
        return deadLink();
      }
    },
    dispose: async () => {
      disposed = true;
      offHeld();
      held?.close();
      held = undefined;
      for (const link of [...links]) { link.dispose(); }
    },
  };
}

async function inProcessConnection(
  deps: HostConnectionDeps, fallbackNotice: string | undefined, attachmentsBaseDir: string,
): Promise<HostConnection> {
  const bus = new PostBus();
  const host: HostHandle = await (deps.createHost ?? realCreateHost)({
    workspaceDir: deps.workspaceDir, config: deps.config, hostKind: 'vscode',
    workspaceRoots: deps.roots, emit: (m) => bus.post(m),
    notify: { warn: deps.notices.warn }, onShellNoise: deps.notices.shellNoise,
  });
  try {
    await host.init();
  } catch (err) {
    // A corrupt index.json must not take the extension down: the panel still comes up with an empty roster.
    console.error('[mar-code] failed to restore session index; starting with an empty roster', err);
  }
  const links = new Set<SurfaceLink>();
  return {
    mode: 'in-process', fallbackNotice, warnings: [], loginRecipes: host.loginRecipes, attachmentsBaseDir,
    connect: async (kind) => {
      const link = createInProcessLink({
        host, bus, kind, defaultCwd: deps.defaultCwd, hooks: deps.hooks, config: deps.config,
        favoriteModels: deps.favoriteModels, showCacheTimer: deps.showCacheTimer,
      });
      links.add(link);
      return link;
    },
    dispose: async () => {
      for (const link of links) { link.dispose(); }
      links.clear();
      await host.dispose();
    },
  };
}
