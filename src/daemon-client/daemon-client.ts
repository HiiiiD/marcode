import type { DaemonInfo } from '../daemon/daemon-info';
import type { ClientTransport } from '../client-core/transport';
import type { ActOp, AskOp, ClientFrame, DaemonIdentity, LoginRecipeWire, ServerFrame } from '../protocol/daemon-wire';
import type { HostToWebview, WebviewToHost } from '../protocol/messages';
import { openLink, type Link, type LinkFailure, type RejectFrame, type WelcomeFrame } from './daemon-link';
import { Outbox } from './outbox';

export type ClientStatus = 'connected' | 'reconnecting' | 'lost';

export interface ClientHooks {
  context?: () => unknown;
  act?(op: ActOp, args: unknown[]): void;
  ask?(op: AskOp, args: unknown[]): Promise<unknown>;
}

export interface DaemonClient extends ClientTransport {
  readonly loginRecipes: LoginRecipeWire[];
  onStatus(cb: (s: ClientStatus) => void): () => void;
  pushContext(ctx: unknown): void;
  close(): void;
}

export interface Opened { link: Link; welcome: WelcomeFrame }
export type Reopen = (cancelled: () => boolean) => Promise<Opened | undefined>;
export interface RetryPolicy { attempts: number; baseMs: number }

export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseMs: 200 };

type HelloFields = Omit<Extract<ClientFrame, { f: 'hello' }>, 'f' | 'token' | 'protocolVersion' | 'appVersion'>;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class SocketDaemonClient implements DaemonClient {
  private recipes: LoginRecipeWire[] = [];
  private readonly listeners = new Set<(m: HostToWebview) => void>();
  private readonly statusListeners = new Set<(s: ClientStatus) => void>();
  private link: Link | undefined;
  private closed = false;
  private pushed: { ctx: unknown } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wake: (() => void) | undefined;
  private reconnecting = false;
  private readonly outbox = new Outbox();
  private lost = false;

  constructor(
    opened: Opened,
    private readonly hooks: ClientHooks,
    private readonly reopen: Reopen,
    private readonly retry: RetryPolicy = DEFAULT_RETRY,
  ) {
    this.adopt(opened);
  }

  get loginRecipes(): LoginRecipeWire[] { return this.recipes; }

  post(msg: WebviewToHost): void {
    if (!this.link) {
      if (this.closed || this.lost || !this.outbox.offer(msg)) {
        console.debug(`[marcode] daemon-client: dropped ${msg.t} while disconnected`);
      }
      return;
    }
    this.link.send({ f: 'msg', m: msg });
  }

  onMessage(listener: (msg: HostToWebview) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onStatus(cb: (s: ClientStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => { this.statusListeners.delete(cb); };
  }

  pushContext(ctx: unknown): void {
    this.pushed = { ctx };
    this.link?.send({ f: 'ctx', ctx });
  }

  close(): void {
    if (this.closed) { return; }
    this.closed = true;
    clearTimeout(this.timer);
    this.wake?.();
    this.link?.destroy();
    this.link = undefined;
    this.outbox.clear();
    this.listeners.clear();
    this.statusListeners.clear();
  }

  private adopt({ link, welcome }: Opened): void {
    this.link = link;
    this.recipes = welcome.loginRecipes;
    link.bind({ frame: (f) => this.onFrame(link, f), dropped: () => this.onDropped(link) });
    const ctx = this.currentContext();
    if (ctx) { link.send({ f: 'ctx', ctx: ctx.ctx }); }
  }

  private currentContext(): { ctx: unknown } | undefined {
    if (!this.hooks.context) { return this.pushed; }
    try { return { ctx: this.hooks.context() }; } catch (err) {
      console.error('[marcode] daemon-client: context hook failed', err);
      return this.pushed;
    }
  }

  private onFrame(link: Link, frame: ServerFrame): void {
    if (this.closed) { return; }
    try {
      if (frame.f === 'msg') {
        for (const l of [...this.listeners]) { l(frame.m); }
      } else if (frame.f === 'act') {
        this.hooks.act?.(frame.op, frame.args);
      } else if (frame.f === 'req') {
        this.answer(link, frame);
      }
    } catch (err) {
      console.error('[marcode] daemon-client: frame handler failed', err);
    }
  }

  private answer(link: Link, req: Extract<ServerFrame, { f: 'req' }>): void {
    const ask = this.hooks.ask;
    if (!ask) { link.send({ f: 'res', id: req.id, ok: false, error: `unsupported: ${req.op}` }); return; }
    void Promise.resolve()
      .then(() => ask(req.op, req.args))
      .then(
        (result) => { link.send({ f: 'res', id: req.id, ok: true, result }); },
        (err: unknown) => { link.send({ f: 'res', id: req.id, ok: false, error: errorText(err) }); },
      );
  }

  private onDropped(link: Link): void {
    if (this.closed || link !== this.link) { return; }
    this.link = undefined;
    // A link that dies while the retry loop is adopting it is that loop's failed attempt, not a new outage.
    if (this.reconnecting) { return; }
    this.emit('reconnecting');
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    this.reconnecting = true;
    try { await this.retryLoop(); } finally { this.reconnecting = false; }
  }

  private async retryLoop(): Promise<void> {
    for (let n = 0; n < this.retry.attempts; n++) {
      await this.sleep(this.retry.baseMs * 2 ** n);
      if (this.closed) { return; }
      let opened: Opened | undefined;
      try { opened = await this.reopen(() => this.closed); } catch (err) {
        console.error('[marcode] daemon-client: reconnect failed', err);
      }
      if (this.closed) { opened?.link.destroy(); return; }
      if (opened) {
        this.adopt(opened);
        if (this.link !== opened.link) { continue; }
        this.post({ t: 'ready' });
        this.emit('connected');
        for (const m of this.outbox.drain()) { this.post(m); }
        return;
      }
    }
    this.lost = true;
    this.outbox.clear();
    if (!this.closed) { this.emit('lost'); }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => { this.wake = undefined; this.timer = undefined; resolve(); };
      this.wake = wake;
      this.timer = setTimeout(wake, ms);
    });
  }

  private emit(s: ClientStatus): void {
    for (const cb of [...this.statusListeners]) {
      try { cb(s); } catch (err) { console.error('[marcode] daemon-client: status listener failed', err); }
    }
  }
}

export const helloFrame = (token: string, hello: HelloFields, identity: DaemonIdentity): Extract<ClientFrame, { f: 'hello' }> =>
  ({ f: 'hello', ...hello, token, ...identity });

export async function attach(
  info: DaemonInfo,
  hello: HelloFields,
  hooks: ClientHooks,
  identity: DaemonIdentity,
  handshakeTimeoutMs?: number,
): Promise<{ client: DaemonClient } | { rejected: RejectFrame } | { failed: LinkFailure }> {
  const frame = helloFrame(info.token, hello, identity);
  const r = await openLink(info.endpoint, frame, handshakeTimeoutMs);
  if (!('link' in r)) { return r; }
  const reopen: Reopen = async () => {
    const again = await openLink(info.endpoint, frame, handshakeTimeoutMs);
    return 'link' in again ? again : undefined;
  };
  return { client: new SocketDaemonClient(r, hooks, reopen) };
}
