import type { ClientTransport } from '../client-core/transport';

let nextReqId = 1;

/** A reply the daemon never sends (its store read threw, or the link dropped) reads as not found. */
export function requestAttachmentPath(
  transport: ClientTransport,
  ref: { id: string; attachmentId: string; itemId?: string },
  timeoutMs = 5000,
): Promise<string | null> {
  const reqId = nextReqId++;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = transport.onMessage((m) => {
      if (m.t === 'attachment-path' && m.reqId === reqId) { finish(m.path); }
    });
    const finish = (path: string | null) => { clearTimeout(timer); off(); resolve(path); };
    timer = setTimeout(() => finish(null), timeoutMs);
    transport.post({ t: 'request-attachment-path', id: ref.id, attachmentId: ref.attachmentId, itemId: ref.itemId, reqId });
  });
}
