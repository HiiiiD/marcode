import { spawn as spawnChildProcess } from 'node:child_process';
import type {
  AgentProvider, AgentRun, Invocable, ModelInfo, PermissionModeInfo, StartOptions, ThreadScope, UsageWindow,
} from '../types';
import { AppServer, type Duplex, type RequestId } from './app-server';
import { CodexRun, type CodexConnection } from './codex-run';
import { CODEX_MODES, effortLevelsOf } from './map-settings';
import { toInvocables } from './map-skills';
import { toUsageWindows } from './map-usage';
import type {
  AccountReadResponse, CodexModel, ModelListResponse, RateLimitsReadResponse, SkillsListResponse,
} from './wire';

/**
 * Notification families `CodexRun`/`CodexProvider` never read.
 *
 * `optOutNotificationMethods` (InitializeParams.capabilities) is how the
 * client tells `app-server` not to bother emitting them: `thread/realtime/*`
 * is the fine-grained token stream this panel doesn't render (full items
 * arrive via `item/started`/`item/completed`, same tradeoff the Claude
 * provider makes by leaving `includePartialMessages` off), `fs/changed` and
 * `app/list/updated` are filesystem/roster watches this extension does not
 * mirror, and `rawResponse/*` is the model's raw wire traffic.
 */
const OPT_OUT = ['thread/realtime/*', 'fs/changed', 'rawResponse/*', 'app/list/updated'];

/**
 * Tracks `package.json`'s `version` field. Not read from it at runtime: this
 * file is bundled for both the Node/CJS host and unit tests run straight
 * from source, and a JSON import would need its own resolution story for a
 * one-line value `initialize` only logs, never branches on.
 */
const CLIENT_VERSION = '0.0.1';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toModelInfo(m: CodexModel): ModelInfo {
  return { id: m.id, displayName: m.displayName, effort: effortLevelsOf(m) };
}

/**
 * How much of the child's stderr is kept for a failure message. Bounded
 * because the point of reading that stream is not to collect it — see below.
 */
const STDERR_TAIL_BYTES = 2048;

/**
 * Real, child-process-backed spawn — the production default, injected away in
 * every test except the two that exist to cover this function.
 *
 * Exported because the real-binary test gate (`src/test/unit/codex-gate.ts`)
 * spawns the same process the same way, and a second copy of the wiring below
 * is a second copy of the bugs it fixes.
 *
 * Three things here are load-bearing, and each one was a way Codex died
 * silently:
 *
 * - **stderr is drained.** `stdio`'s third slot is a pipe, and a pipe nobody
 *   reads fills at ~64KB and then BLOCKS the writer. A chatty app-server
 *   (tracing, profile warnings) would wedge mid-turn on a write to fd 2 and
 *   stop answering JSON-RPC — no error, no close, every session parked in
 *   `running` forever. Draining it is the fix; keeping a bounded tail is the
 *   bonus, since a startup failure's actual reason only ever exists there.
 * - **`'error'` is handled.** `spawn` does not throw on ENOENT; it emits
 *   `'error'` on the ChildProcess asynchronously. Unhandled, EventEmitter
 *   rethrows it — an uncaught exception in the extension host, which is what
 *   a user with no `codex` on PATH used to get instead of a message.
 * - **`'exit'` is handled.** stdout closing usually follows, but "usually" is
 *   not a contract, and the exit carries the code and signal that say why.
 */
export function spawnAppServer(bin: string): Duplex {
  const child = spawnChildProcess(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });

  let tail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
  });
  // Same reasoning as the stdin/stdout handlers in `AppServer`: an unhandled
  // stream 'error' is a thrown exception in the host.
  child.stderr?.on('error', () => {});

  let notify: (reason: string) => void = () => {};
  let failed = false;
  const fail = (reason: string): void => {
    // First reason wins: an ENOENT 'error' is followed by an 'exit', and the
    // spawn failure is the more useful of the two.
    if (failed) { return; }
    failed = true;
    const detail = tail.trim();
    notify(detail ? `${reason}: ${detail}` : reason);
  };
  child.on('error', (err: Error) => { fail(`codex app-server failed to start (${err.message})`); });
  child.on('exit', (code, signal) => {
    fail(`codex app-server exited (${signal ?? `code ${code}`})`);
  });

  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    kill: () => { child.kill(); },
    onFailure: (cb) => { notify = cb; },
  };
}

/**
 * One `CodexRun`'s private window onto the provider's single shared
 * `AppServer`.
 *
 * `request`/`respond` pass straight through, once the connection exists.
 * `onNotification`/`onServerRequest`/`onClose` are local single-slot setters
 * — the same shape `AppServer` itself exposes — but scoped to this view
 * alone: `CodexProvider` registers exactly one set of handlers on the real
 * `AppServer` (`wireFanout`, below) and broadcasts every incoming frame to
 * every live view's slot, rather than letting each `CodexRun` fight over the
 * one slot `AppServer` actually has. `CodexRun` already filters what it
 * receives by its own `threadId` (codex-run.ts), so a plain broadcast is
 * enough — nothing here needs to know which thread belongs to which view.
 */
class ThreadView implements CodexConnection {
  notify: (method: string, params: unknown) => void = () => {};
  serverRequest: (method: string, id: RequestId, params: unknown) => void = () => {};
  closed: (reason: string) => void = () => {};

  constructor(private readonly getServer: () => Promise<AppServer>) {}

  request<T>(method: string, params: unknown): Promise<T> {
    return this.getServer().then((server) => server.request<T>(method, params));
  }

  respond(id: RequestId, result: unknown): void {
    this.getServer().then((server) => { server.respond(id, result); }).catch(() => {
      // Best-effort, same contract as AppServer.respond: nothing awaits this.
    });
  }

  onNotification(cb: (method: string, params: unknown) => void): void { this.notify = cb; }
  onServerRequest(cb: (method: string, id: RequestId, params: unknown) => void): void {
    this.serverRequest = cb;
  }
  onClose(cb: (reason: string) => void): void { this.closed = cb; }
}

/**
 * Codex, via the CLI's `app-server` JSON-RPC service.
 *
 * `app-server` is the only Codex surface that can raise an approval to the
 * client and wait for an answer — the SDK and `exec --json` both fix the
 * approval policy at start — which is what makes it the transport for a panel
 * whose whole point is answering approvals.
 *
 * One process serves every Codex session, ref-counted by live runs.
 */
export class CodexProvider implements AgentProvider {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  /**
   * Measured, not assumed: a thread started in one directory and resumed from
   * another kept its conversation, against codex-cli 0.147.0. Threads are
   * keyed by id inside the app-server and `cwd` is only a per-thread start
   * parameter, so nothing about the history is filed under a directory the
   * way Claude's `~/.claude/projects/<slug>` is.
   *
   * The measurement is `src/test/unit/relocation-smoke.test.ts`, which asserts
   * this value against what it observes — so if a future CLI files history per
   * directory, that test fails rather than this comment quietly going stale.
   *
   * Consequence: relocating a Codex session is a native resume and spends no
   * tokens on replay.
   */
  readonly threadScope: ThreadScope = 'global';

  /**
   * The last answer from `fetchModels()`, and the whole of what this
   * provider knows. Empty until a probe succeeds — see `ClaudeProvider`'s
   * identical field for the full reasoning. `SessionManager.catalog()` is
   * what reads this list as the provider's availability signal.
   */
  private models: ModelInfo[] = [];

  /** Every view handed to a live `CodexRun`. Its size IS the ref count. */
  private readonly views = new Set<ThreadView>();

  /** Cached across every caller — see `connection()`. */
  private connectionPromise: Promise<AppServer> | undefined;
  /**
   * The same instance `connectionPromise` resolves to, set the moment it is
   * constructed rather than only once `initialize` answers. `start()` (see
   * below) must be able to spawn the process and hand out a run synchronously
   * — `connectionPromise` staying pending on `initialize` must not stop
   * `teardown()` from reaching the child to kill it.
   */
  private serverInstance: AppServer | undefined;

  /**
   * Mutable so `setBinPath` can change it after construction. `opts.binPath`
   * seeds it but is never read again after the constructor — every other
   * read goes through this field, which is what lets a config change reach
   * a process that is already running.
   */
  private binPath: string | undefined;

  /**
   * The pending zero-refcount teardown, if one is armed. See
   * `scheduleTeardown` for why the kill is not immediate.
   */
  private teardownTimer: NodeJS.Timeout | undefined;

  /**
   * How long the shared process survives its last run, so a dispose that is
   * immediately followed by a new `start()` reuses it. Configurable purely so
   * tests need not wait out the real grace period.
   */
  private readonly teardownGraceMs: number;

  constructor(private readonly opts: {
    binPath?: string;
    spawn?: (bin: string) => Duplex;
    teardownGraceMs?: number;
  } = {}) {
    this.binPath = opts.binPath;
    this.teardownGraceMs = opts.teardownGraceMs ?? 5000;
  }

  listModels(): ModelInfo[] { return this.models; }

  /**
   * The five modes Codex can honor. See map-settings.ts for why
   * `acceptEdits` is the one Claude mode missing.
   */
  listPermissionModes(): PermissionModeInfo[] { return CODEX_MODES; }

  /**
   * Spawns the shared `app-server` process exactly once (memoized on
   * `connectionPromise`) and runs its `initialize` handshake. Every other
   * method in this class routes through this, so every caller shares the one
   * process this provider is responsible for.
   *
   * A failure — spawn or handshake — clears the cached promise so the next
   * call retries from scratch (e.g. after `refreshModels`), rather than
   * replaying the same rejection forever.
   */
  private connection(): Promise<AppServer> {
    if (!this.connectionPromise) { this.connectionPromise = this.connect(); }
    return this.connectionPromise;
  }

  private async connect(): Promise<AppServer> {
    const bin = this.binPath ?? 'codex';
    let child: Duplex;
    try {
      child = (this.opts.spawn ?? spawnAppServer)(bin);
    } catch {
      this.connectionPromise = undefined;
      // This message IS the availability UX — see fetchModels()'s header.
      throw new Error('Codex CLI not found. Install it, or set marcode.codex.path.');
    }
    const server = new AppServer(child);
    this.serverInstance = server;
    this.wireFanout(server);
    try {
      await server.request('initialize', {
        clientInfo: { name: 'mar-code', title: null, version: CLIENT_VERSION },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: OPT_OUT,
        },
      });
    } catch (err) {
      // Symmetric with the spawn-failure branch above: a rejected handshake
      // leaves a live child behind unless it is disposed here — otherwise
      // nothing ever holds it, the next start()/fetch* spawns a fresh one,
      // and every repeated failure leaks one more `codex app-server`
      // process for the life of the window.
      server.dispose();
      this.connectionPromise = undefined;
      this.serverInstance = undefined;
      throw err;
    }
    return server;
  }

  /**
   * The provider's one registration on the real `AppServer`'s single-slot
   * callbacks, fanned out to every live run's private view. See `ThreadView`
   * above for why this exists at all.
   */
  private wireFanout(server: AppServer): void {
    server.onNotification((method, params) => {
      for (const view of this.views) { view.notify(method, params); }
    });
    server.onServerRequest((method, id, params) => {
      for (const view of this.views) { view.serverRequest(method, id, params); }
    });
    server.onClose((reason) => {
      // A closed `AppServer` rejects every subsequent request with
      // 'app-server is not running', forever. Leaving it in the cache is what
      // turned one process death — a crash, an OOM kill, a pipe lost to a
      // sleeping machine, a CLI upgrade swapping the binary underneath — into
      // a Codex that stayed broken for the life of the window: new sessions
      // got the same corpse, and `refreshModels` re-probed through it, so even
      // the availability mechanism could not recover. Dropping it here makes
      // the next `connection()` reconnect, exactly as the spawn- and
      // handshake-failure paths already do.
      //
      // Identity-checked so a late close from a process already replaced (by
      // `setBinPath`, say) cannot evict its successor.
      if (this.serverInstance === server) {
        this.connectionPromise = undefined;
        this.serverInstance = undefined;
      }
      for (const view of this.views) { view.closed(reason); }
    });
  }

  /**
   * The CLI's own model catalog, from a session-free probe over the shared
   * connection: `account/read` first (a signed-out account has no models
   * worth listing), then `model/list`. Neither request is cwd-scoped — both
   * are process/account-global, per the verified `GetAccountParams`/
   * `ModelListParams` shapes — so `cwd` is accepted here only because every
   * other probe in this class takes one; it is not sent on the wire.
   *
   * `model/list` defaults `includeHidden` to `false` server-side, so the
   * `.filter` below is belt-and-braces, not compensating for a server that
   * actually sends hidden rows by default.
   *
   * This is also the availability probe: a rejection clears the cache, so an
   * install that stops working takes the provider out of the picker on the
   * next refresh. Every rejection here is the provider's unavailability
   * reason verbatim — `session-manager` shows this text to the user, not a
   * developer, so it says what to do about it: install/configure Codex, or
   * run `codex login`.
   */
  async fetchModels(_cwd: string): Promise<ModelInfo[]> {
    try {
      const server = await this.connection();
      const account = await server.request<AccountReadResponse>('account/read', {});
      // `requiresOpenaiAuth` describes whether this provider requires OpenAI
      // auth AT ALL, not whether it is currently missing — measured against
      // a live, signed-in ChatGPT Plus account on codex-cli 0.147.0, it
      // comes back `true` right alongside a populated `account`. The signal
      // this class actually wants is `account` itself: null/absent is what
      // "not signed in" means. See wire.ts's AccountReadResponse doc.
      if (!account.account) {
        throw new Error('Not signed in to Codex. Run `codex login`.');
      }
      const catalog = await server.request<ModelListResponse>('model/list', {});
      const models = catalog.data.filter((m) => !m.hidden).map(toModelInfo);
      this.models = models;
      return models;
    } catch (err) {
      this.models = [];
      throw err instanceof Error ? err : new Error(errorMessage(err));
    }
  }

  /**
   * Account/plan usage for a working directory, with NO session required —
   * `account/rateLimits/read` is process-global, same as the Claude
   * provider's usage probe. Rejections propagate: `SessionManager` decides
   * the retry policy.
   *
   * `cwd` is accepted (every probe in this class takes one) and NOT sent: the
   * request declares `params: undefined`, a serde unit. Sending `{ cwd }` is
   * not tolerated the way an unknown *field* would be — measured live on
   * codex-cli 0.147.0 it fails outright with `Invalid request: invalid type:
   * map, expected unit`, so `fetchUsage` rejected every time and the usage
   * strip never populated at activation. Same fix as `account/read` and
   * `model/list` above.
   */
  async fetchUsage(_cwd: string): Promise<UsageWindow[] | undefined> {
    const server = await this.connection();
    const response = await server.request<RateLimitsReadResponse>('account/rateLimits/read', {});
    return toUsageWindows(response.rateLimits);
  }

  /**
   * The cwd's skill catalog, with no thread.
   *
   * `skills/list` is keyed by `cwds` (plural, an array — `SkillsListParams`).
   * The response mapping lives in map-skills.ts because `CodexRun` needs the
   * same one when it re-pulls after a `skills/changed` invalidation.
   */
  async listInvocables(cwd: string): Promise<Invocable[]> {
    const server = await this.connection();
    const response = await server.request<SkillsListResponse>('skills/list', { cwds: [cwd] });
    return toInvocables(response);
  }

  /**
   * Hands out one `CodexRun` sharing this provider's connection. Ref-counted
   * by `views`: the run's own `dispose()` (via the hook passed below) drops
   * its view and, once nothing else is using the process, tears it down.
   *
   * `connection()` is called (not awaited) here purely to trigger — and
   * memoize — the spawn: two `start()` calls before either resolves must
   * still spawn only once, which is why the spawn itself happens
   * synchronously inside `connect()`'s pre-`await` prologue.
   */
  start(opts: StartOptions): AgentRun {
    // Claims the process back from a teardown armed by a dispose moments ago
    // — which is exactly the shape of a relocation, and the whole reason the
    // grace period exists.
    this.cancelTeardown();
    this.connection().catch(() => {
      // A connect failure surfaces to the run itself, the first time it
      // tries to use the connection (its own request() calls reject) — not
      // as an unhandled rejection here.
    });
    const view = new ThreadView(() => this.connection());
    this.views.add(view);
    return new CodexRun(view, opts, () => {
      this.views.delete(view);
      if (this.views.size === 0) { this.scheduleTeardown(); }
    });
  }

  /**
   * Arms a teardown for once the ref count has stayed at zero for the grace
   * period.
   *
   * Relocation is dispose-then-reconstruct, so moving the only Codex session
   * drops this provider's ref count to zero and picks it straight back up.
   * Killing on the way down would respawn a large Rust binary and re-run its
   * handshake between two adjacent statements, for nothing. Anything that
   * attaches inside the window keeps the process it was already going to use.
   *
   * Unref'd: a pending grace timer must never be the reason the extension
   * host's event loop stays alive after everything else has been disposed.
   */
  private scheduleTeardown(): void {
    if (this.teardownTimer) { return; }
    this.teardownTimer = setTimeout(() => {
      this.teardownTimer = undefined;
      // Re-checked rather than trusted: `cancelTeardown` clears the timer on
      // every path that reclaims the process, but a check here costs nothing
      // and makes the kill unconditionally correct.
      if (this.views.size > 0) { return; }
      this.teardown();
    }, this.teardownGraceMs);
    this.teardownTimer.unref?.();
  }

  private cancelTeardown(): void {
    if (!this.teardownTimer) { return; }
    clearTimeout(this.teardownTimer);
    this.teardownTimer = undefined;
  }

  /**
   * Updates the binary path a *future* `connect()` will spawn, and drops
   * any process already running against the old one — a cached
   * `connectionPromise`/`serverInstance` pinned to the previous binary
   * would otherwise silently outlive the setting that named it, and
   * `refreshModels`'s re-probe (the mechanism this exists to serve — see
   * `session-manager.ts`) would just retry the same stale spawn.
   *
   * Disposal here is unconditional, unlike the ref-counted `teardown()` a
   * run's own `dispose()` triggers: a user who changes the binary has
   * declared the running one wrong, and continuing to run sessions against
   * it is worse than ending them. Any `ThreadView` still attached hears
   * `onClose` from this and turns it into `turn-end: error` (see
   * `CodexRun`) — the honest outcome, not one to suppress.
   */
  setBinPath(binPath: string | undefined): void {
    this.binPath = binPath;
    // No grace here, and the armed one (if any) is dropped: it was going to
    // kill a process that is now the wrong process anyway.
    this.cancelTeardown();
    this.teardown();
  }

  /** Kills the shared process — via `start()`'s ref-count reaching zero, or via `setBinPath`. */
  private teardown(): void {
    const server = this.serverInstance;
    this.connectionPromise = undefined;
    this.serverInstance = undefined;
    server?.dispose();
  }
}
