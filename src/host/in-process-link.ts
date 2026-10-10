import { createLoopback } from '../client-core/loopback-transport';
import { wantsFor } from '../daemon/client-wants';
import type { ClientKind } from '../protocol/daemon-wire';
import type { HookSet } from './act-adapter';
import type { HostHandle } from './create-host';
import type { HostConfig } from './host-config';
import { MessageRouter, type UpdateNotifyHost } from './message-router';
import type { PostBus } from './post-bus';
import type { SurfaceLink } from './surface-link';

export interface InProcessLinkDeps {
  host: HostHandle;
  bus: PostBus;
  kind: ClientKind;
  defaultCwd: string;
  hooks: HookSet & { updateNotify: UpdateNotifyHost };
  config: HostConfig;
  favoriteModels: () => string[];
  showCacheTimer: boolean;
}

/** What each panel used to build for itself: a router on the local manager plus a gated bus registration. */
export function createInProcessLink(d: InProcessLinkDeps): SurfaceLink {
  const loopback = createLoopback((msg) => router.handle(msg));
  const router = new MessageRouter(
    d.host.manager, (m) => loopback.deliver(m), d.defaultCwd, d.hooks.editor, d.host.attachments, d.hooks.picker,
    d.config.review.pollIntervalMs, d.hooks.fileSearch, d.favoriteModels(), d.hooks.configHost,
    d.kind === 'sidebar' ? d.hooks.updateNotify : undefined, d.showCacheTimer,
  );
  const unregister = d.bus.add({ post: (m) => loopback.deliver(m), wants: wantsFor(d.kind) });
  let disposed = false;
  return {
    transport: loopback.transport,
    onStatus: () => () => {},
    status: () => 'connected',
    pushContext: () => {},
    dispose: () => { if (!disposed) { disposed = true; unregister(); } },
  };
}
