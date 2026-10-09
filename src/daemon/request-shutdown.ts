import * as net from 'node:net';
import type { ServerFrame } from '../protocol/daemon-wire';
import { encodeFrame, LineDecoder, parseFrame } from './protocol';

export type ShutdownAnswer = 'bye' | 'busy' | 'bad-token' | 'unreachable';

export function requestShutdown(endpoint: string, token: string, timeoutMs = 5_000): Promise<ShutdownAnswer> {
  return new Promise((resolve) => {
    const sock = net.connect(endpoint);
    const dec = new LineDecoder();
    let answered = false;
    const finish = (a: ShutdownAnswer) => {
      if (answered) { return; }
      answered = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(a);
    };
    const timer = setTimeout(() => finish('unreachable'), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('error', () => finish('unreachable'));
    sock.on('close', () => finish('unreachable'));
    sock.on('connect', () => { sock.write(encodeFrame({ f: 'shutdown', token })); });
    sock.on('data', (chunk: string) => {
      let lines: string[];
      try { lines = dec.push(chunk); } catch { finish('unreachable'); return; }
      for (const line of lines) {
        const frame = parseFrame(line) as ServerFrame | undefined;
        if (frame?.f === 'bye') { finish('bye'); return; }
        if (frame?.f === 'refuse') { finish(frame.reason); return; }
      }
    });
  });
}
