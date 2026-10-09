import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { PostBus } from '../host/post-bus';
import { DaemonConnection, type ConnectionDeps, type FrameSocket } from './connection';
import { probeEndpoint } from './probe-endpoint';

const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
const END_GRACE_MS = 1_000;

export interface DaemonServerOptions {
  endpoint: string;
  connectionDeps: Omit<ConnectionDeps, 'addToBus' | 'onChange' | 'onRoots'> & { onChange(): void };
  bus: PostBus;
  startupRoots?: string[];
  helloTimeoutMs?: number;
}

function vetSocketDir(dir: string): void {
  const st = fs.lstatSync(dir);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (st.isSymbolicLink() || !st.isDirectory() || (uid !== undefined && st.uid !== uid)) {
    throw new Error(`Refusing to listen: socket directory ${dir} is a symlink or not owned by this user`);
  }
  if ((st.mode & 0o077) !== 0) { fs.chmodSync(dir, 0o700); }
}

export class DaemonServer {
  private readonly server = net.createServer((socket) => this.accept(socket));
  private readonly connections = new Set<DaemonConnection>();
  private readonly rootsByConn = new Map<object, string[]>();
  private readonly rootsListeners: Array<() => void> = [];
  private closing: Promise<void> | undefined;

  constructor(private readonly opts: DaemonServerOptions) {
    this.server.on('error', (err) => console.error('[marcode] daemon: server error', err));
  }

  async listen(): Promise<void> {
    const posix = process.platform !== 'win32';
    if (posix) {
      const dir = path.dirname(this.opts.endpoint);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      vetSocketDir(dir);
      // Unlinking a live daemon's socket would orphan its clients; only a positive "nobody listens" frees it.
      if (fs.existsSync(this.opts.endpoint) && await probeEndpoint(this.opts.endpoint) !== 'free') {
        throw new Error(`Refusing to listen: ${this.opts.endpoint} is already served`);
      }
      fs.rmSync(this.opts.endpoint, { force: true });
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.endpoint, () => { this.server.off('error', reject); resolve(); });
    });
    if (posix) {
      try { fs.chmodSync(this.opts.endpoint, 0o600); } catch (err) {
        await this.close();
        throw err;
      }
    }
  }

  close(): Promise<void> {
    this.closing ??= new Promise<void>((resolve) => {
      // The server only emits close once every connection has ended; the adapter's end() destroys stragglers.
      this.server.close(() => resolve());
      for (const conn of [...this.connections]) {
        try { conn.close(); } catch (err) { console.error('[marcode] daemon: close failed', err); }
      }
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
