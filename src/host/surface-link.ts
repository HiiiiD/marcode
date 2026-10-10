import type { ClientTransport } from '../client-core/transport';
import type { ClientStatus } from '../daemon-client/daemon-client';
import type { ClientKind } from '../protocol/daemon-wire';
import type { LoginRecipe } from './create-host';

/** What a panel holds: a transport onto the host, whether that is a daemon socket or a local router. */
export interface SurfaceLink {
  readonly transport: ClientTransport;
  onStatus(cb: (s: ClientStatus) => void): () => void;
  /** The current state, for a surface that subscribed after the transition. */
  status(): ClientStatus;
  /** Daemon links forward editor context to the daemon; in-process routers read it from the hooks. */
  pushContext(ctx: unknown): void;
  dispose(): void;
}

export interface HostConnection {
  readonly mode: 'daemon' | 'in-process';
  /** Set when a daemon was wanted but not used; completes "Running without the background host: …". */
  readonly fallbackNotice: string | undefined;
  /** Things the user should know about the daemon this window attached to. */
  readonly warnings: string[];
  readonly loginRecipes: Map<string, LoginRecipe>;
  /** Where pasted attachments live, for the webview resource roots. */
  readonly attachmentsBaseDir: string;
  /** Never rejects: a surface that cannot reach the host gets a link that reports `lost`. */
  connect(kind: ClientKind): Promise<SurfaceLink>;
  dispose(): Promise<void>;
}
