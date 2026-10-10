import { randomUUID } from 'node:crypto';
import type { ClientFrame, ClientKind, DaemonIdentity, LoginRecipeWire, RejectReason, ServerFrame } from '../protocol/daemon-wire';
import type { HostToWebview, WebviewToHost } from '../protocol/messages';
import type { PostClient } from '../host/post-bus';
import { wantsFor } from './client-wants';
import { createRemoteHooks } from './remote-hooks';
import { encodeFrame, isHelloShape, LineDecoder, parseFrame } from './protocol';

export type HelloFrame = Extract<ClientFrame, { f: 'hello' }>;
type ResFrame = Extract<ClientFrame, { f: 'res' }>;
type RemoteHooks = ReturnType<typeof createRemoteHooks>;

const DEFAULT_MAX_BUFFERED = 32 * 1024 * 1024;
const DEFAULT_ASK_TIMEOUT_MS = 30_000;

export interface FrameSocket {
  write(data: string): boolean;
  end(): void;
  buffered(): number;
  onData(cb: (chunk: string) => void): void;
  onClose(cb: () => void): void;
}

export interface ConnectionDeps {
  token: string;
  identity: DaemonIdentity;
  loginRecipes: LoginRecipeWire[];
  isBusy(): boolean;
  makeRouter(emit: (m: HostToWebview) => void, hooks: RemoteHooks, hello: HelloFrame): ConnectionRouter;
  addToBus(client: PostClient): () => void;
  onRoots(roots: string[]): () => void;
  onShutdown(): void;
  onChange(): void;
  maxBuffered?: number;
  askTimeoutMs?: number;
}

export interface ConnectionRouter { handle(m: WebviewToHost): Promise<void>; dispose?(): void }

interface PendingAsk { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }

export class DaemonConnection {
  private readonly decoder = new LineDecoder();
  private hello: HelloFrame | undefined;
  private router: ConnectionRouter | undefined;
  private hooks: RemoteHooks | undefined;
  private unbus: (() => void) | undefined;
  private unroots: (() => void) | undefined;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingAsk>();

  constructor(private readonly socket: FrameSocket, private readonly deps: ConnectionDeps) {
    socket.onData((chunk) => this.onChunk(chunk));
    socket.onClose(() => this.teardown());
  }

  get kind(): ClientKind | undefined { return this.hello?.clientKind; }
  get attached(): boolean { return this.unbus !== undefined && !this.closed; }
  close(): void { this.socket.end(); this.teardown(); }

  private send(frame: ServerFrame): void { if (!this.closed) { this.socket.write(encodeFrame(frame)); } }

  private onChunk(chunk: string): void {
    if (this.closed) { return; }
    let lines: string[];
    try { lines = this.decoder.push(chunk); } catch { this.close(); return; }
    for (const line of lines) {
      const frame = parseFrame(line);
      if (!frame) { this.close(); return; }
      // A throwing dep must not escape the socket callback and take the whole daemon down.
      try { this.onFrame(frame as ClientFrame); } catch (err) {
        console.error('[marcode] daemon: frame failed', err);
        this.close();
      }
      if (this.closed) { return; }
    }
  }

  private onFrame(frame: ClientFrame): void {
    if (frame.f === 'shutdown') { this.onShutdownFrame(frame.token); return; }
    if (!this.hello) {
      if (frame.f !== 'hello') { this.reject('bad-hello'); return; }
      this.onHello(frame);
      return;
    }
    switch (frame.f) {
      case 'msg': this.dispatch(frame.m); return;
      case 'ctx': this.hooks?.setContext(frame.ctx as Parameters<RemoteHooks['setContext']>[0]); return;
      case 'res': this.settle(frame); return;
      default: return;
    }
  }

  private dispatch(m: WebviewToHost): void {
    const router = this.router;
    if (!router) { return; }
    // A synchronous throw from handle() must not escape onData either.
    void Promise.resolve()
      .then(() => router.handle(m))
      .catch((err: unknown) => console.error('[marcode] daemon: handler failed', err));
  }

  private onHello(hello: HelloFrame): void {
    if (hello.token !== this.deps.token) { this.reject('bad-token'); return; }
    if (hello.protocolVersion !== this.deps.identity.protocolVersion) { this.reject('protocol-mismatch'); return; }
    if (!isHelloShape(hello)) { this.reject('bad-hello'); return; }
    this.hello = hello;
    this.unroots = this.deps.onRoots(hello.roots);
    const hooks = createRemoteHooks({
      act: (op, args) => this.send({ f: 'act', op, args }),
      ask: (op, args) => new Promise((resolve, reject) => {
        if (this.closed) { reject(new Error('closed')); return; }
        const id = this.nextId++;
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout')); }, this.deps.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS);
        this.pending.set(id, { resolve, reject, timer });
        this.send({ f: 'req', id, op, args });
      }),
    });
    this.hooks = hooks;
    this.router = this.deps.makeRouter((m) => this.send({ f: 'msg', m }), hooks, hello);
    this.unbus = this.deps.addToBus({ wants: wantsFor(hello.clientKind), post: (m) => this.post(m) });
    this.send({ f: 'welcome', clientId: randomUUID(), loginRecipes: this.deps.loginRecipes, ...this.deps.identity });
    this.deps.onChange();
  }

  private post(m: HostToWebview): void {
    if (this.closed) { return; }
    // A client this far behind is dropped; it recovers by reconnecting and re-hydrating.
    if (this.socket.buffered() > (this.deps.maxBuffered ?? DEFAULT_MAX_BUFFERED)) { this.close(); return; }
    this.send({ f: 'msg', m });
  }

  private reject(reason: RejectReason): void {
    this.send({ f: 'reject', reason, daemon: this.deps.identity });
    this.close();
  }

  private onShutdownFrame(token: string): void {
    if (token !== this.deps.token) { this.send({ f: 'refuse', reason: 'bad-token' }); return; }
    if (this.deps.isBusy()) { this.send({ f: 'refuse', reason: 'busy' }); return; }
    this.send({ f: 'bye' });
    this.deps.onShutdown();
  }

  private settle(res: ResFrame): void {
    const entry = this.pending.get(res.id);
    if (!entry) { return; }
    this.pending.delete(res.id);
    clearTimeout(entry.timer);
    if (res.ok) { entry.resolve(res.result); } else { entry.reject(new Error(res.error)); }
  }

  private teardown(): void {
    if (this.closed) { return; }
    this.closed = true;
    this.unbus?.();
    this.unroots?.();
    try { this.router?.dispose?.(); } catch (err) { console.error('[marcode] daemon: router dispose failed', err); }
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('closed')); }
    this.pending.clear();
    this.deps.onChange();
  }
}
