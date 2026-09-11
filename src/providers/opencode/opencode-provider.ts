import { spawn as spawnChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { connectAcp, CLIENT_CAPABILITIES, PROTOCOL_VERSION, type AcpChild } from '../acp/acp-client';
import { modelConfigId, toEffort, toModels, type ConfigOption } from '../acp/config-options';
import { AcpRun } from '../acp/acp-run';
import { openCodeModeId } from './map-modes';
import { openCodeTools } from './map-tools';
import { reserveLoopbackPort } from './reserve-port';
import { SubagentWatch } from './subagent-watch';
import {
  localVersion, githubLatestVersion, type ExecVersionFn, type FetchFn, type UpdateInfo,
} from '../update-check';
import type {
  AgentProvider, AgentRun, ModelInfo, PermissionModeInfo, SelfControlMcpConfig,
  StartOptions, ThreadScope,
} from '../types';

const STDERR_TAIL_BYTES = 2000;

/**
 * The connection `connectAcp` hands back, narrowed to the three calls this
 * probe makes. Same structural-narrowing move `AcpRun` makes with its own
 * `AcpConnection` — it keeps the SDK's ESM-only `.d.ts` out of this module's
 * inference and lets a scripted `PassThrough` pair stand in for a real
 * `ClientSideConnection` in tests.
 */
interface AcpProbeConnection {
  initialize(params: unknown): Promise<unknown>;
  newSession(params: unknown): Promise<{ sessionId: string; configOptions?: ConfigOption[] }>;
  setSessionConfigOption(params: unknown): Promise<{ configOptions?: ConfigOption[] } | undefined>;
  closeSession(params: unknown): Promise<unknown>;
}

/**
 * How long the effort sweep (see `probe`) waits for one model's config write
 * before moving on. Measured cost of the whole sweep on a real install
 * (opencode 1.18.30, 380 models) was ~300ms total — this bounds the failure
 * case, not the happy path: a single model that never answers must not hang
 * the entire catalog, the way one slow model previously could have hung
 * `fetchModels` outright.
 */
const CONFIG_OPTION_TIMEOUT_MS = 3000;

/** Bounded retries for a spawn that failed because the port this run
 *  reserved was claimed by something else between reservation and
 *  `opencode acp`'s own bind. Same shape as `self-control-mcp-server.ts`'s
 *  `PORT_ATTEMPTS`. */
const SPAWN_PORT_ATTEMPTS = 5;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `shell: true` is not optional on Windows: `opencode` resolves to a `.cmd`
 * shim, and Node 22 refuses to spawn one directly (EINVAL) since the
 * command-injection hardening in 20.x.
 */
export function spawnOpenCodeAcp(binPath: string | undefined, env: NodeJS.ProcessEnv | undefined, port?: number): AcpChild {
  const bin = binPath ?? 'opencode';
  // `port` is omitted for `fetchModels`'s probe (see `this.spawn`'s default
  // below) — a probe session never needs the subagent-visibility server, so
  // it spawns exactly as it always has, with no `--port` flag at all.
  const args = port !== undefined ? ['acp', '--port', String(port), '--hostname', '127.0.0.1'] : ['acp'];
  const child = spawnChildProcess(bin, args, {
    stdio: ['pipe', 'pipe', 'pipe'], shell: true, windowsHide: true, ...(env ? { env } : {}),
  });
  let tail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
  });
  child.stderr?.on('error', () => {});
  let notify: (reason: string) => void = () => {};
  let failed = false;
  const fail = (reason: string): void => {
    if (failed) { return; }
    failed = true;
    const detail = tail.trim();
    notify(detail ? `${reason}: ${detail}` : reason);
  };
  child.on('error', (err: Error) => { fail(`opencode acp failed to start (${err.message})`); });
  child.on('exit', (code, signal) => { fail(`opencode acp exited (${signal ?? `code ${code}`})`); });
  return {
    stdin: child.stdin!, stdout: child.stdout!,
    kill: () => { child.kill(); },
    onFailure: (cb) => { notify = cb; },
  };
}

/**
 * The four modes OpenCode can actually honor. `auto` needs a classifier ACP
 * does not provide, and `acceptEdits` is indistinguishable from `default`
 * under a config that does not ask about edits — the same reason Codex omits
 * it. Every description names where the prompting decision really lives.
 */
const OPENCODE_MODES: PermissionModeInfo[] = [
  { id: 'default', description: "OpenCode's build agent. Whether it prompts is your opencode.json." },
  { id: 'plan', description: 'Plan mode. OpenCode disallows all edit tools.' },
  { id: 'bypass', description: 'Answers every permission request with allow, without asking you.' },
  { id: 'dontAsk', description: 'Rejects anything OpenCode asks about. Calls its config already allows still run.' },
];

export class OpenCodeProvider implements AgentProvider {
  readonly id: string;
  readonly displayName: string;
  /**
   * Measured on 1.18.18: a `session/load` from a directory other than the one
   * that created the session replays the full history and then never answers.
   * Relocation therefore reseeds by replay rather than resuming natively.
   */
  readonly threadScope: ThreadScope = 'cwd';
  readonly loginKind?: 'oauth' | 'none';

  private models: ModelInfo[] = [];
  private readonly binPath?: string;
  private readonly spawn: (bin: string, env?: NodeJS.ProcessEnv, port?: number) => AcpChild;
  private readonly selfControlMcp?: SelfControlMcpConfig;
  /** Instance env override, merged into every spawned `opencode acp` process's env. */
  private readonly env?: NodeJS.ProcessEnv;
  private readonly execVersion?: ExecVersionFn;
  private readonly fetchLatest?: FetchFn;
  /** Test-only override for `CONFIG_OPTION_TIMEOUT_MS` — see `probe`. */
  private readonly configOptionTimeoutMs: number;
  /** Test-only override for `reserveLoopbackPort` — see `attemptSpawn`. */
  private readonly reservePort: () => Promise<number>;

  /**
   * Deliberately never assigned. ACP carries no plan-usage data, so this
   * provider has nothing to poll and omits `fetchUsage` the same way a
   * provider with no plan limits at all is meant to — see the interface's
   * own doc. Declared (not simply left off the class) so `listModels()`'s
   * sibling optional-member callers, and this provider's own tests, can read
   * `provider.fetchUsage` and see `undefined` rather than a compile error.
   */
  readonly fetchUsage?: AgentProvider['fetchUsage'];

  constructor(opts: {
    id?: string;
    displayName?: string;
    binPath?: string;
    spawn?: (bin: string, env?: NodeJS.ProcessEnv, port?: number) => AcpChild;
    selfControlMcp?: SelfControlMcpConfig;
    env?: NodeJS.ProcessEnv;
    loginKind?: 'oauth' | 'none';
    execVersion?: ExecVersionFn;
    fetchLatest?: FetchFn;
    configOptionTimeoutMs?: number;
    reservePort?: () => Promise<number>;
  } = {}) {
    this.id = opts.id ?? 'opencode';
    this.displayName = opts.displayName ?? 'OpenCode';
    this.binPath = opts.binPath;
    this.spawn = opts.spawn ?? ((bin, env, port) => spawnOpenCodeAcp(bin, env, port));
    this.selfControlMcp = opts.selfControlMcp;
    this.env = opts.env;
    this.loginKind = opts.loginKind;
    this.execVersion = opts.execVersion;
    this.fetchLatest = opts.fetchLatest;
    this.configOptionTimeoutMs = opts.configOptionTimeoutMs ?? CONFIG_OPTION_TIMEOUT_MS;
    this.reservePort = opts.reservePort ?? reserveLoopbackPort;
  }

  /** Instance env merged over `process.env`, or `undefined` when there is no override. */
  private mergedEnv(): NodeJS.ProcessEnv | undefined {
    return this.env ? { ...process.env, ...this.env } : undefined;
  }

  listModels(): ModelInfo[] { return this.models; }
  listPermissionModes(): PermissionModeInfo[] { return OPENCODE_MODES; }

  async checkForUpdate(): Promise<UpdateInfo | undefined> {
    const bin = this.binPath ?? 'opencode';
    const [current, latest] = await Promise.all([
      localVersion(bin, ['--version'], this.execVersion),
      githubLatestVersion('anomalyco/opencode', 'v', this.fetchLatest),
    ]);
    if (!current || !latest) { return undefined; }
    return { current, latest };
  }

  /**
   * The catalog arrives with `session/new`, so the probe opens a session and
   * closes it again — an unclosed probe session would show up in the user's
   * own opencode history. Every rejection here is the unavailability reason
   * the panel shows verbatim, so it says what to do about it.
   *
   * Raced against `child.onFailure`, same reasoning as `AcpRun.start()`: with
   * `shell: true` (required on Windows — see `spawnOpenCodeAcp`), a missing
   * `opencode` binary does not make `this.spawn(...)` throw. It launches a
   * shell that exits async with "not recognized", and without this race the
   * probe below never sees that — it only ever fails once the SDK's own
   * stream-close handling rejects every pending request with the generic
   * `"ACP connection closed"`, which names neither the binary nor a fix.
   */
  async fetchModels(cwd: string): Promise<ModelInfo[]> {
    let child: AcpChild;
    try {
      child = this.spawn(this.binPath ?? 'opencode', this.mergedEnv());
    } catch {
      this.models = [];
      throw new Error('opencode not found. Install it, or set marcode.opencode.path.');
    }
    const failure = new Promise<never>((_, reject) => {
      child.onFailure?.((reason) => { reject(new Error(reason)); });
    });
    try {
      return await Promise.race([this.probe(child, cwd), failure]);
    } catch (err) {
      // A failed re-probe must not leave a stale catalog behind — the
      // model list IS the availability signal, so an install that stops
      // answering must stop claiming models it can no longer confirm.
      this.models = [];
      throw err;
    } finally {
      child.kill();
    }
  }

  private async probe(child: AcpChild, cwd: string): Promise<ModelInfo[]> {
    const connection = await connectAcp(child, {
      sessionUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    }) as unknown as AcpProbeConnection;
    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: { name: 'mar-code-probe', version: '0.0.1' },
    });
    const session = await connection.newSession({ cwd, mcpServers: [] });
    const base = toModels(session.configOptions ?? []);
    // Effort is a property of the SELECTED model, not of the catalog: it
    // only shows up in `configOptions` once a reasoning-capable model is
    // actually switched to — see `toEffort`. So the catalog answer alone
    // never carries it; this sweeps every model through the same session,
    // one config write each, and reads the reply back. Measured on a real
    // install (opencode 1.18.30, 380 models): ~300ms for the whole sweep,
    // on top of the ~1.4s the handshake above already costs — cheap enough
    // to do unconditionally rather than only on demand.
    const configId = modelConfigId(session.configOptions ?? []) ?? 'model';
    // Sequential, not parallel: every write lands on the same session, and
    // concurrent switches would race each other's replies against a single
    // piece of live agent state.
    const models: ModelInfo[] = [];
    for (const model of base) {
      const options = await this.switchAndRead(connection, session.sessionId, configId, model.id);
      const effort = toEffort(options);
      models.push(effort ? { ...model, effort } : model);
    }
    this.models = models;
    try {
      await connection.closeSession({ sessionId: session.sessionId });
    } catch {
      // Best effort. A probe session left open is untidy, not broken —
      // and never a reason to report the provider as unavailable.
    }
    return this.models;
  }

  /**
   * One model's config write during the effort sweep, bounded by
   * `configOptionTimeoutMs` so a single unresponsive model cannot hang the
   * whole catalog probe. Never throws: a rejected or timed-out write just
   * means this model's effort stays unknown, exactly like a model whose
   * `session/new` reply carried no `thought_level` option at all.
   */
  private async switchAndRead(
    connection: AcpProbeConnection, sessionId: string, configId: string, modelId: string,
  ): Promise<ConfigOption[]> {
    const write = connection.setSessionConfigOption({ sessionId, configId, value: modelId })
      .then((reply) => reply?.configOptions ?? [])
      .catch(() => [] as ConfigOption[]);
    const timeout = new Promise<ConfigOption[]>((resolve) => {
      setTimeout(() => resolve([]), this.configOptionTimeoutMs);
    });
    return Promise.race([write, timeout]);
  }

  start(opts: StartOptions): AgentRun {
    const token = randomBytes(24).toString('hex');
    const watch = new SubagentWatch(); // opened once a real child has actually spawned — see attemptSpawn
    const { child, markStarted } = this.spawnWithPort(token, watch);
    const run = new AcpRun(child, {
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      permissionMode: opts.permissionMode,
      resumeToken: opts.resumeToken,
      sessionId: opts.sessionId,
      tools: openCodeTools,
      modeId: openCodeModeId,
      clientName: 'mar-code',
      selfControlMcp: this.selfControlMcp,
      childEvents: watch.events,
      // `onSessionId` fires once, the moment a real opencode session id
      // exists (see `AcpRunOptions`) — the earliest point a fresh process
      // could no longer silently replace this one without losing state, so
      // it also marks `attemptSpawn`'s own "genuinely active" flag.
      onSessionId: (id) => { watch.setRootSessionId(id); markStarted(); },
      // Fallback, not the primary path: `watch` normally learns this same
      // correlation itself, live, off the root's own `task` part the moment
      // opencode marks it `running` — see `subagent-watch.ts`'s `handlePart`.
      // This fires later (only once the PRIMARY ACP connection's completed
      // frame arrives) and is what catches a subagent fast enough to finish
      // before `watch`'s own, separate SDK connection ever came up.
      onSubagentSpawned: (taskToolCallId, childSessionId) => watch.setParentToolCallId(childSessionId, taskToolCallId),
      onDispose: () => watch.close(),
    });
    watch.setPermissionHandler((id, tool, meta, parentId) => run.handleAuxiliaryPermission(id, tool, meta, parentId));
    return run;
  }

  /**
   * `start()` must return an `AgentRun` synchronously (the interface's own
   * contract), but reserving a port is async. Spawns a real `AcpChild`
   * immediately whose `stdin`/`stdout` are PassThroughs wired to the *real*
   * child once the port is reserved and `opencode acp --port <n>` actually
   * launches — so nothing downstream (`AcpRun`, `connectAcp`) ever sees a
   * synchronous/async seam. Retries `SPAWN_PORT_ATTEMPTS` times on a spawn
   * failure (`AcpChild.onFailure`), each with a freshly reserved port.
   */
  private spawnWithPort(token: string, watch: SubagentWatch): { child: AcpChild; markStarted: () => void } {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let killed = false;
    // Both boxes exist for the same reason: `attemptSpawn` is invoked here,
    // synchronously, before `new AcpRun(...)` has even started running its
    // own constructor — so a plain captured variable/parameter would still
    // be bound to `placeholder`'s default no-op `onFailure` handler forever,
    // never the real one `AcpRun` registers a moment later. Reading through
    // a shared, mutable box at call time (not a value captured at spawn
    // time) is what lets every `notify.current(...)` below actually reach
    // AcpRun once it exists. `active` extends the same pattern across every
    // retry attempt, for `kill()` — see its own comment below.
    const notify: { current: (reason: string) => void } = { current: () => {} };
    const active: { child?: AcpChild } = {};
    // `active.child` alone can't tell a startup attempt that hasn't
    // finished handshaking yet (still safe to retry) from a genuinely
    // running session (a crash on THIS must be terminal, not retried) — a
    // brand new attempt becomes `active.child` immediately, on spawn, well
    // before any ACP handshake completes. `started` is the second half of
    // that distinction: it flips true exactly once, when `markStarted` is
    // called (wired to `AcpRun`'s own `onSessionId` in `start()`), and never
    // resets — a real opencode session id existing at all is the earliest
    // point a retry would silently orphan server-side state.
    const started = { value: false };
    // AcpRun's `initialize` (and everything else it writes before a session
    // actually starts) goes out over `stdin` exactly once — a retry's fresh
    // child never saw any of it, since Node streams aren't rewindable and
    // the bytes were already consumed by whichever attempt was piped in at
    // the time. Buffering everything written before `started` flips, and
    // replaying it into each new attempt's real stdin before piping resumes
    // live, is what lets a retry recover an in-flight handshake instead of
    // hanging forever on a reply that can never arrive.
    const replay: Buffer[] = [];
    stdin.on('data', (chunk: Buffer) => { if (!started.value) { replay.push(chunk); } });
    const placeholder: AcpChild = {
      stdin, stdout,
      kill: () => { killed = true; active.child?.kill(); },
      onFailure: (cb) => { notify.current = cb; },
    };
    void this.attemptSpawn(token, watch, stdin, stdout, () => killed, notify, SPAWN_PORT_ATTEMPTS, active, started, replay);
    return { child: placeholder, markStarted: () => { started.value = true; } };
  }

  private async attemptSpawn(
    token: string, watch: SubagentWatch, stdin: PassThrough, stdout: PassThrough,
    isKilled: () => boolean, notify: { current: (reason: string) => void }, attemptsLeft: number,
    active: { child?: AcpChild }, started: { value: boolean }, replay: Buffer[],
  ): Promise<void> {
    if (isKilled()) { return; }
    let port: number;
    try {
      port = await this.reservePort();
    } catch (err) {
      notify.current(`could not reserve a port for opencode acp (${errorMessage(err)})`);
      return;
    }
    // `?? process.env`, not a bare spread: `mergedEnv()` answers `undefined`
    // when there is no instance override (the default provider), and
    // `{ ...undefined }` is `{}` — a child spawned with no PATH at all, which
    // under `shell: true` cannot even resolve `opencode`. `fetchModels` passes
    // `mergedEnv()` straight through and so never notices.
    const env = { ...(this.mergedEnv() ?? process.env), OPENCODE_SERVER_PASSWORD: token };
    const bin = this.binPath ?? 'opencode';
    let child: AcpChild;
    try {
      child = this.spawn(bin, env, port);
    } catch (err) {
      notify.current(`opencode acp failed to start (${errorMessage(err)})`);
      return;
    }
    active.child = child;
    // Only now — a real child process exists for this port — does the
    // watcher's own connection attempt make sense. Opening earlier (right
    // after reservation) would let a retried attempt leave a prior `open()`
    // racing a port nothing ever bound to.
    watch.open(`http://127.0.0.1:${port}`, token);
    child.onFailure?.((reason) => {
      // This attempt's own child already exited on its own — unpipe it from
      // the shared streams before a retry reuses them, or its own stdout
      // reaching EOF (default `pipe` behavior) would `.end()` the shared
      // `stdout` out from under the NEXT, successful attempt.
      // `active.child === child` alone would also be true for a brand new
      // attempt that has not even finished handshaking yet — `started`
      // (see `spawnWithPort`) is what narrows this to a genuine, running
      // session, not merely "the most recent attempt".
      const isGenuineCrash = active.child === child && started.value;
      child.stdout.unpipe(stdout);
      stdin.unpipe(child.stdin);
      if (isGenuineCrash) {
        active.child = undefined;
        // `{ end: false }` above exists so a failed STARTUP attempt never
        // severs the stream a retry still needs — but this child had
        // already become the active, running session, so this is a real
        // post-startup crash, not a startup casualty. Nothing else will
        // ever end the shared `stdout` now, so `AcpRun`'s own reader
        // (`connectAcp`'s `Readable.toWeb`) would otherwise never learn the
        // connection died and just hang forever — end it ourselves, the
        // same signal a plain `.pipe()` gave it before retries existed.
        // Terminal, not retried: an already-active session has transcript
        // history and state a fresh `opencode acp` process cannot silently
        // resume, so this always reports failure rather than reusing
        // `attemptsLeft` to swap in a blank replacement behind it.
        stdout.end();
        notify.current(reason);
        return;
      }
      if (active.child === child) { active.child = undefined; }
      if (attemptsLeft > 1 && /port|EADDRINUSE/i.test(reason)) {
        void this.attemptSpawn(token, watch, stdin, stdout, isKilled, notify, attemptsLeft - 1, active, started, replay);
      } else {
        notify.current(reason);
      }
    });
    // Replay whatever AcpRun already wrote (nothing, on the first attempt;
    // at minimum `initialize`, on any retry) into this attempt's real child
    // before piping future writes live — order preserved, since these
    // synchronous `write()` calls complete before `.pipe()` starts
    // forwarding anything new.
    for (const chunk of replay) { child.stdin.write(chunk); }
    // `end: false`: a failed attempt's own child exiting must not end these
    // shared PassThroughs — the next retry (or `dispose()`, via `stdin`)
    // still needs them live.
    child.stdout.pipe(stdout, { end: false });
    stdin.pipe(child.stdin, { end: false });
    if (isKilled()) { child.kill(); }
  }
}
