import type { ClientTransport } from '../client-core/transport';
import type { HostToWebview } from '../protocol/messages';

/** Subscribe before posting the request, or the reply can beat the listener. */
export function awaitMessage(
  transport: Pick<ClientTransport, 'onMessage'>, match: (m: HostToWebview) => boolean, timeoutMs: number,
): Promise<HostToWebview | undefined> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = transport.onMessage((m) => { if (match(m)) { finish(m); } });
    const finish = (m: HostToWebview | undefined) => { clearTimeout(timer); off(); resolve(m); };
    timer = setTimeout(() => finish(undefined), timeoutMs);
  });
}
