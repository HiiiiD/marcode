import type { ClientTransport } from '../client-core/transport';
import type { PaneLayout } from '../protocol/messages';

/** The sidebar's last pane layout, kept so pane commands need no round trip to the host. */
export function trackLayout(
  transport: Pick<ClientTransport, 'onMessage'>,
): { current(): PaneLayout | undefined; dispose(): void } {
  let layout: PaneLayout | undefined;
  // Called on the transport itself: a DaemonClient's onMessage reads `this`.
  const off = transport.onMessage((m) => {
    if (m.t === 'hydrate' || m.t === 'layout-changed') { layout = m.layout; }
  });
  return { current: () => layout, dispose: off };
}
