import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { PostBus } from '../host/post-bus';
import { DaemonConnection, type ConnectionDeps, type FrameSocket } from './connection';

const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
const END_GRACE_MS = 1_000;

export interface DaemonServerOptions {
  endpoint: string;
  connectionDeps: Omit<ConnectionDeps, 'addToBus' | 'onChange' | 'onRoots'> & { onChange(): void };
  bus: PostBus;
  startupRoots?: string[];
  helloTimeoutMs?: number;
}

export class DaemonServer {
  private readonly server = net.createServer((socket) => this.accept(socket));
  private readonly connections = new Set<DaemonConnection>();
  private readonly sockets = new Set<net.Socket>();
  private readonly rootsByConn = new Map<object, string[]>();
  private readonly rootsListeners: Array<() => void> = [];
  private closing: Promise<void> | undefined;

  constructor(private readonly opts: DaemonServerOptions) {}

  async listen(): Promise<void> {
    const posix = process.platform !== 'win32';
    if (posix) {
      fs.mkdirSync(path.dirname(this.opts.endpoint), { recursive: true, mode: 0o700 });
      fs.rmSync(this.opts.endpoint, { force: true });
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.endpoint, () => { this.server.off('error', reject); resolve(); });
    });
    if (posix) { fs.chmodSync(this.opts.endpoint, 0o600); }
  }

  close(): Promise<void> {
    this.closing ??= new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      for (const conn of [...this.connections]) { conn.close(); }
      for (const socket of this.sockets) { socket.destroy(); }
      if (!this.server.listening) { resolve(); }
    });
    return this.closing;
  }

  clientCount(): number {
    let n = 0;
    for (const conn of this.connections) { if (conn.attached) { n++; } }
    return n;
  }

  roots(): string[] {
    const all = new Set(this.opts.startupRoots ?? []);
    for (const roots of this.rootsByConn.values()) { for (const r of roots) { all.add(r); } }
    return [...all];
  }

  onRootsChanged(cb: () => void): void { this.rootsListeners.push(cb); }

  private notifyRoots(): void {
    for (const cb of this.rootsListeners) {
      try { cb(); } catch (err) { console.error('[marcode] daemon: roots listener failed', err); }
    }
  }

  private accept(socket: net.Socket): void {
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    this.sockets.add(socket);
    const key = {};
    const conn = new DaemonConnection(this.frameSocket(socket), {
      ...this.opts.connectionDeps,
      addToBus: (c) => this.opts.bus.add(c),
      onRoots: (roots) => {
        this.rootsByConn.set(key, roots);
        this.notifyRoots();
        return () => { if (this.rootsByConn.delete(key)) { this.notifyRoots(); } };
      },
    });
    this.connections.add(conn);
    const deadline = setTimeout(() => { if (!conn.attached) { socket.destroy(); } }, this.opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS);
    deadline.unref();
    socket.once('close', () => {
      clearTimeout(deadline);
      this.connections.delete(conn);
      this.sockets.delete(socket);
    });
  }

  private frameSocket(socket: net.Socket): FrameSocket {
    const guard = <A extends unknown[]>(tag: string, cb: (...a: A) => void) => (...a: A): void => {
      try { cb(...a); } catch (err) {
        console.error(`[marcode] daemon: ${tag} failed`, err);
        socket.destroy();
      }
    };
    return {
      write: (data) => socket.write(data),
      end: () => {
        socket.end();
        setTimeout(() => socket.destroy(), END_GRACE_MS).unref();
      },
      buffered: () => socket.writableLength,
      onData: (cb) => { socket.on('data', guard('data', cb)); },
      onClose: (cb) => { socket.on('close', guard('close', cb)); },
    };
  }
}
