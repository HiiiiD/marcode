export type RequestId = number | string;

/** The child process, narrowed to what this module uses, so tests can stub it. */
export interface Duplex {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  kill(): void;
  /**
   * Process-level death, with a reason — a failed spawn or an exit.
   *
   * Distinct from the stream events this class already listens to, and not
   * derivable from them: `spawn` reports ENOENT by emitting `'error'` on the
   * ChildProcess itself, which is an object `Duplex` deliberately does not
   * expose. Left unset by a stub that has no process behind it; the spawner
   * that does own one (`defaultSpawn`) is where the reason — stderr tail
   * included — gets composed.
   */
  onFailure?(cb: (reason: string) => void): void;
}

/**
 * How long a stdout close waits for the process `exit` that explains it. Long
 * enough for the few milliseconds measured between the two, short enough that
 * a process which closes its output without ever exiting still fails fast.
 */
const EXIT_REASON_GRACE_MS = 250;

/**
 * A line-framed JSON-RPC connection to `codex app-server`.
 *
 * One connection serves every Codex session: the protocol multiplexes
 * conversations by `threadId`, and a process per session would multiply a
 * large Rust binary by the roster size — which is the cost the panel exists
 * to avoid. Dispatch by thread is the caller's job; this class knows only
 * frames.
 *
 * No `vscode` import, and the process is injected rather than spawned here,
 * so the whole thing unit-tests against a pair of PassThrough streams.
 */
export class AppServer {
  private nextId = 1;
  private readonly pending = new Map<RequestId, {
    resolve: (v: never) => void; reject: (e: Error) => void;
  }>();
  private buffer = '';
  private closed = false;
  private notify: (method: string, params: unknown) => void = () => {};
  private serverRequest: (method: string, id: RequestId, params: unknown) => void = () => {};
  private closeCb: (reason: string) => void = () => {};

  constructor(private readonly child: Duplex) {
    child.stdout.on('data', (chunk: Buffer) => { this.ingest(chunk.toString()); });
    child.stdout.on('close', () => {
      // Immediate when nothing owns a process — a stub's streams closing is
      // the whole of the news, and no better reason is coming.
      if (!child.onFailure) { this.close('app-server closed its output'); return; }
      // Otherwise held briefly, and only this reason is: when a real process
      // dies its stdio streams close a few milliseconds BEFORE `exit` fires
      // (measured: stdout close at 156ms, exit at 158ms, for a child that
      // died on startup), and `exit` is the event that knows the code, the
      // signal and the stderr tail — the whole of why. `close()` is
      // first-reason-wins, so without the grace this generic sentence would
      // always beat the useful one, and every crash would read identically.
      // If nothing better arrives, it still fires: a connection left open
      // over a dead pipe parks every request forever, which is the thing
      // listening here exists to prevent.
      const timer = setTimeout(() => {
        this.close('app-server closed its output');
      }, EXIT_REASON_GRACE_MS);
      timer.unref?.();
    });
    // A pipe error is otherwise an unhandled 'error' event — Node's default
    // behavior for that is to throw, which would crash the extension host
    // rather than land on a session as an error item.
    child.stdout.on('error', (err: Error) => {
      this.close(`app-server stdout error: ${err.message}`);
    });
    child.stdin.on('error', (err: Error) => {
      this.close(`app-server stdin error: ${err.message}`);
    });
    // A spawn failure never reaches the streams at all — nothing is ever
    // piped — so without this an unusable binary leaves every request pending
    // forever instead of rejecting with a reason the user can act on.
    child.onFailure?.((reason) => { this.close(reason); });
  }

  onNotification(cb: (method: string, params: unknown) => void): void { this.notify = cb; }
  onServerRequest(cb: (method: string, id: RequestId, params: unknown) => void): void {
    this.serverRequest = cb;
  }
  onClose(cb: (reason: string) => void): void { this.closeCb = cb; }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) { return Promise.reject(new Error('app-server is not running')); }
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
    });
    this.write({ id, method, params });
    return promise;
  }

  /** Answers a server-initiated request. Fire-and-forget by design. */
  respond(id: RequestId, result: unknown): void {
    if (this.closed) { return; }
    this.write({ id, result });
  }

  /**
   * Public for tests, and because stdout arrives in arbitrary chunks: a frame
   * can be split mid-token across two `data` events, so the tail is buffered
   * rather than parsed per chunk.
   */
  ingest(text: string): void {
    this.buffer += text;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) { this.dispatch(line); }
      newline = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let frame: {
      id?: RequestId; method?: string; params?: unknown; result?: unknown;
      error?: { message?: string };
    };
    try {
      frame = JSON.parse(line);
    } catch {
      // Tolerant by policy: a line we cannot parse is a line we ignore. The
      // alternative is one stray write killing every live session.
      console.warn('[hiiiid-code] codex: unparseable frame');
      return;
    }

    if (frame.method !== undefined && frame.id !== undefined) {
      this.serverRequest(frame.method, frame.id, frame.params);
      return;
    }
    if (frame.method !== undefined) {
      this.notify(frame.method, frame.params);
      return;
    }
    if (frame.id === undefined) { return; }

    const waiter = this.pending.get(frame.id);
    if (!waiter) { return; }
    this.pending.delete(frame.id);
    if (frame.error) {
      waiter.reject(new Error(frame.error.message ?? 'app-server error'));
    } else {
      waiter.resolve(frame.result as never);
    }
  }

  /**
   * A synchronous throw from `stdin.write` (e.g. writing to an already-dead
   * pipe) must not escape to the caller of `request`/`respond` — that would
   * turn "errors are state" into an actual thrown exception. Route it into
   * the same `close` path a stdin 'error' event takes, so every in-flight
   * request rejects with one usable message instead of one call throwing
   * while the rest hang.
   */
  private write(frame: unknown): void {
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.close(`app-server stdin write failed: ${message}`);
    }
  }

  /**
   * Every in-flight request rejects with the same reason.
   *
   * A caller awaiting a dead process would otherwise hang forever, and a
   * session stuck in 'running' with no way out is worse than one in 'error'
   * with a message.
   */
  close(reason: string): void {
    if (this.closed) { return; }
    this.closed = true;
    for (const { reject } of this.pending.values()) { reject(new Error(reason)); }
    this.pending.clear();
    this.closeCb(reason);
  }

  dispose(): void {
    this.close('app-server disposed');
    this.child.kill();
  }
}
