import * as net from 'node:net';
import * as os from 'node:os';
import type { DaemonInfo } from '../../daemon/daemon-info';
import { encodeFrame, LineDecoder } from '../../daemon/protocol';

export interface RawClient { sock: net.Socket; frames: any[]; send(f: object): void; closed(): boolean }

export function rawClient(endpoint: string): Promise<RawClient> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(endpoint);
    const dec = new LineDecoder();
    const frames: any[] = [];
    let closed = false;
    sock.setEncoding('utf8');
    sock.on('data', (c: string) => { for (const l of dec.push(c)) { frames.push(JSON.parse(l)); } });
    sock.on('close', () => { closed = true; });
    sock.once('connect', () => resolve({ sock, frames, closed: () => closed, send: (f) => { sock.write(encodeFrame(f as never)); } }));
    sock.once('error', reject);
  });
}

export const rawHello = (info: DaemonInfo, protocolVersion = info.protocolVersion) => ({
  f: 'hello', protocolVersion, appVersion: info.appVersion, clientKind: 'tui', token: info.token, roots: [], defaultCwd: os.tmpdir(),
});

export const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) { await new Promise((r) => setTimeout(r, 10)); }
};
