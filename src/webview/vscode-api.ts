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

export function onHostMessage(fn: (msg: HostToWebview) => void): () => void {
  const listener = (event: MessageEvent<HostToWebview>) => fn(event.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
