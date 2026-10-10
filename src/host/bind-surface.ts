import type * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from '../protocol/messages';
import type { SurfaceLink } from './surface-link';

export interface SurfaceHandlers {
  /** Return true when the message was handled client-side and must not reach the host. */
  intercept?(raw: WebviewToHost, link: SurfaceLink): boolean | Promise<boolean>;
  /** Sees every host message before it is posted to the webview; a returned message replaces it. */
  onHostMessage?(msg: HostToWebview, link: SurfaceLink): HostToWebview | void;
  /** Runs after the (possibly replaced) message has been posted to the webview. */
  afterHostMessage?(msg: HostToWebview, link: SurfaceLink): void;
  /** Runs once the link exists; whatever it returns is called on dispose. */
  onLink?(link: SurfaceLink): (() => void) | void;
}

export interface SurfaceBinding {
  link(): SurfaceLink | undefined;
  post(msg: HostToWebview): void;
  dispose(): void;
}

type WebviewLike = Pick<vscode.Webview, 'onDidReceiveMessage' | 'postMessage'>;

/**
 * Wires one webview to the host. The link is asynchronous (a daemon attach can take a moment), so
 * messages the webview sends first are queued and replayed in order; a binding disposed before its
 * link arrives disposes that link when it does.
 */
export function bindSurface(
  webview: WebviewLike, connect: () => Promise<SurfaceLink>, handlers: SurfaceHandlers,
): SurfaceBinding {
  let link: SurfaceLink | undefined;
  let disposed = false;
  // Messages wait here until the link exists and the backlog has drained, so a late message never overtakes an early one.
  const queue: WebviewToHost[] = [];
  let draining = true;
  const cleanups: Array<() => void> = [];

  const post = (msg: HostToWebview) => { void webview.postMessage(msg); };

  const dispatch = async (raw: WebviewToHost, l: SurfaceLink): Promise<void> => {
    try {
      if (await handlers.intercept?.(raw, l)) { return; }
      l.transport.post(raw);
    } catch (err) {
      console.error('[mar-code] message handling failed', raw?.t, err);
    }
  };

  const received = webview.onDidReceiveMessage((raw: WebviewToHost) => {
    if (link && !draining) { void dispatch(raw, link); } else { queue.push(raw); }
  });

  connect().then(async (l) => {
    if (disposed) { l.dispose(); return; }
    link = l;
    cleanups.push(l.transport.onMessage((m) => {
      let out = m;
      try { out = handlers.onHostMessage?.(m, l) ?? m; } catch (err) { console.error('[mar-code] host message handler failed', m.t, err); }
      post(out);
      try { handlers.afterHostMessage?.(m, l); } catch (err) { console.error('[mar-code] host message handler failed', m.t, err); }
    }));
    const undo = handlers.onLink?.(l);
    if (undo) { cleanups.push(undo); }
    while (queue.length > 0 && !disposed) { await dispatch(queue.shift() as WebviewToHost, l); }
    draining = false;
  }).catch((err: unknown) => { console.error('[mar-code] could not connect a surface', err); });

  return {
    link: () => link,
    post,
    dispose: () => {
      if (disposed) { return; }
      disposed = true;
      received.dispose();
      for (const undo of cleanups.splice(0)) { undo(); }
      link?.dispose();
    },
  };
}
