import type { HostToWebview, WebviewToHost } from '../protocol/messages';

export interface ClientTransport {
  post(msg: WebviewToHost): void;
  onMessage(listener: (msg: HostToWebview) => void): () => void;
}
