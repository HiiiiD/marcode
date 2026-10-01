import type { HostToWebview, WebviewToHost } from '../protocol/messages';
import type { ClientTransport } from './transport';

export interface Loopback { transport: ClientTransport; deliver(msg: HostToWebview): void }

export function createLoopback(handle: (msg: WebviewToHost) => void | Promise<void>): Loopback {
  const listeners = new Set<(msg: HostToWebview) => void>();
  return {
    deliver: (msg) => { for (const l of [...listeners]) { l(msg); } },
    transport: {
      post: (msg) => {
        const fail = (err: unknown) => { console.error('[marcode] loopback: handler failed', msg.t, err); };
        try {
          void Promise.resolve(handle(msg)).catch(fail);
        } catch (err) {
          fail(err);
        }
      },
      onMessage: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
  };
}
