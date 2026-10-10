import * as net from 'node:net';
import type { ServerFrame } from '../protocol/daemon-wire';
import { encodeFrame, LineDecoder, parseFrame } from './protocol';

/** `unreachable` is a refused connect (nobody there); `timeout` is a peer that never answered. */
export type ShutdownAnswer = 'bye' | 'busy' | 'bad-token' | 'unreachable' | 'timeout';

const NOBODY_THERE = new Set(['ECONNREFUSED', 'ENOENT']);

export function requestShutdown(endpoint: string, token: string, timeoutMs = 5_000): Promise<ShutdownAnswer> {
  return new Promise((resolve) => {
    const sock = net.connect(endpoint);
    const dec = new LineDecoder();
    let answered = false;
    let connected = false;
    let code: string | undefined;
    const finish = (a: ShutdownAnswer) => {
      if (answered) { return; }
      answered = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(a);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('error', (err: NodeJS.ErrnoException) => { code ??= err.code; });
    sock.on('close', () => {
      finish(!connected && code !== undefined && NOBODY_THERE.has(code) ? 'unreachable' : 'timeout');
    });
    sock.on('connect', () => { connected = true; sock.write(encodeFrame({ f: 'shutdown', token })); });
    sock.on('data', (chunk: string) => {
      let lines: string[];
      try { lines = dec.push(chunk); } catch { finish('timeout'); return; }
      for (const line of lines) {
        const frame = parseFrame(line) as ServerFrame | undefined;
        if (frame?.f === 'bye') { finish('bye'); return; }
        if (frame?.f === 'refuse') { finish(frame.reason); return; }
      }
    });
  });
}
