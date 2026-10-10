import type { HostToWebview, PaneLayout } from '../protocol/messages';

/** The sidebar's last pane layout, kept so pane commands need no round trip to the host. */
export function trackLayout(
  onMessage: (listener: (m: HostToWebview) => void) => () => void,
): { current(): PaneLayout | undefined; dispose(): void } {
  let layout: PaneLayout | undefined;
  const off = onMessage((m) => {
    if (m.t === 'hydrate' || m.t === 'layout-changed') { layout = m.layout; }
  });
  return { current: () => layout, dispose: off };
}
