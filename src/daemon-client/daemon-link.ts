import * as net from 'node:net';
import { encodeFrame, LineDecoder, parseFrame } from '../daemon/protocol';
import type { ClientFrame, ServerFrame } from '../protocol/daemon-wire';

export type HelloFrame = Extract<ClientFrame, { f: 'hello' }>;
export type WelcomeFrame = Extract<ServerFrame, { f: 'welcome' }>;
export type RejectFrame = Extract<ServerFrame, { f: 'reject' }>;
export type LinkFailure = 'unreachable' | 'timeout';
export type LinkResult =
  | { link: Link; welcome: WelcomeFrame }
  | { rejected: RejectFrame }
  | { failed: LinkFailure };

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3_000;

export interface LinkSink { frame(f: ServerFrame): void; dropped(): void }

/** One handshaken socket. Frames that arrive before `bind` are queued, not lost. */
export class Link {
  private sink: LinkSink | undefined;
  private queue: ServerFrame[] = [];
  private gone = false;
  private byUs = false;

  constructor(private readonly sock: net.Socket) {}

  send(frame: ClientFrame): void {
    if (!this.gone && !this.sock.destroyed) { this.sock.write(encodeFrame(frame)); }
  }

  bind(sink: LinkSink): void {
    this.sink = sink;
    const queued = this.queue;
    this.queue = [];
    for (const f of queued) { sink.frame(f); }
    if (this.gone && !this.byUs) { sink.dropped(); }
  }

  destroy(): void {
    this.byUs = true;
    this.gone = true;
    this.sock.destroy();
  }

  deliver(frame: ServerFrame): void {
    if (this.sink) { this.sink.frame(frame); } else { this.queue.push(frame); }
  }

  dropped(): void {
    if (this.gone) { return; }
    this.gone = true;
    this.sink?.dropped();
  }
}

const NOBODY_THERE = new Set(['ECONNREFUSED', 'ENOENT']);

/**
 * Never rejects. Only a connect refused before `connect` is `unreachable`; a peer that
 * accepted but never welcomed us (blocked, stopping, garbage) is `timeout`, never stale.
 */
export function openLink(endpoint: string, hello: HelloFrame, timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS): Promise<LinkResult> {
  return new Promise((resolve) => {
    const sock = net.connect(endpoint);
    const dec = new LineDecoder();
    let link: Link | undefined;
    let done = false;
    let connected = false;
    let code: string | undefined;
    const settle = (r: LinkResult) => {
      if (done) { return; }
      done = true;
      clearTimeout(timer);
      if (!('link' in r)) { sock.destroy(); }
      resolve(r);
    };
    const timer = setTimeout(() => settle({ failed: 'timeout' }), timeoutMs);
    timer.unref();
    sock.setEncoding('utf8');
    sock.on('error', (err: NodeJS.ErrnoException) => { code ??= err.code; });
    sock.on('close', () => {
      if (link) { link.dropped(); return; }
      settle({ failed: !connected && code !== undefined && NOBODY_THERE.has(code) ? 'unreachable' : 'timeout' });
    });
    sock.on('connect', () => { connected = true; sock.write(encodeFrame(hello)); });
    sock.on('data', (chunk: string) => {
      let lines: string[];
      try { lines = dec.push(chunk); } catch { sock.destroy(); return; }
      for (const line of lines) {
        const frame = parseFrame(line) as ServerFrame | undefined;
        if (!frame) { sock.destroy(); return; }
        if (link) { link.deliver(frame); continue; }
        if (frame.f === 'welcome') {
          link = new Link(sock);
          settle({ link, welcome: frame });
        } else if (frame.f === 'reject') {
          settle({ rejected: frame });
          return;
        } else {
          settle({ failed: 'timeout' });
          return;
        }
      }
    });
  });
}
