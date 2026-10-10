import * as net from 'node:net';

export type ProbeResult = 'live' | 'free' | 'unknown';

export interface ProbeSocket {
  once(event: 'connect' | 'error', cb: (err?: NodeJS.ErrnoException) => void): unknown;
  destroy(): void;
}

export interface ProbeOptions {
  connect?: (endpoint: string) => ProbeSocket;
  timeoutMs?: number;
}

const NOBODY_THERE = new Set(['ECONNREFUSED', 'ENOENT']);

/** `free` only on a positive "nobody listens"; a timeout or any other error may still be a live owner. */
export function probeEndpoint(endpoint: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  // The extra listener keeps a late second error from becoming an uncaught exception.
  const connect: (e: string) => ProbeSocket = opts.connect ?? ((e: string) => net.connect(e).on('error', () => {}));
  return new Promise((resolve) => {
    const sock = connect(endpoint);
    let done = false;
    const finish = (r: ProbeResult) => {
      if (done) { return; }
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish('unknown'), opts.timeoutMs ?? 500);
    sock.once('connect', () => finish('live'));
    sock.once('error', (err) => finish(err?.code !== undefined && NOBODY_THERE.has(err.code) ? 'free' : 'unknown'));
  });
}
