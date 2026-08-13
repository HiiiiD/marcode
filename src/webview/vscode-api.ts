import type { HostToWebview, WebviewToHost } from '../protocol/messages';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function postToHost(msg: WebviewToHost): void {
  api.postMessage(msg);
}

/**
 * Shape guard for inbound `message` events.
 *
 * Exported so it can be unit-tested without a DOM: a VS Code webview's `message`
 * channel is not exclusively the host's — it is a regular `window` postMessage
 * channel, and anything with a reference to this webview's window (another
 * extension, a misbehaving script) can post to it. We only check for an object
 * with a string `t` discriminant here; `reduce`'s exhaustive switch plus its
 * `default` no-op case is the second, authoritative layer that rejects any
 * value shaped like a message but naming an unrecognized variant.
 */
export function isHostMessage(data: unknown): data is HostToWebview {
  return typeof data === 'object' && data !== null
    && typeof (data as { t?: unknown }).t === 'string';
}

export function onHostMessage(fn: (msg: HostToWebview) => void): () => void {
  const listener = (event: MessageEvent<unknown>) => {
    if (isHostMessage(event.data)) {
      fn(event.data);
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
