import type { HostToWebview } from '../protocol/messages';
import type { ClientTransport } from './transport';

/** Client-side settings the host does not send; each client stamps them onto `hydrate` itself. */
export interface HydrateStamp {
  autoGrid?: boolean;
}

export function stampHydrate(msg: HostToWebview, stamp: HydrateStamp): HostToWebview {
  return msg.t === 'hydrate' ? { ...msg, ...stamp } : msg;
}

export function withHydrateStamp(transport: ClientTransport, stamp: HydrateStamp): ClientTransport {
  return {
    post: (msg) => transport.post(msg),
    onMessage: (listener) => transport.onMessage((msg) => listener(stampHydrate(msg, stamp))),
  };
}
