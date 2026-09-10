import { spawn as spawnChildProcess } from 'node:child_process';
import { connectAcp, CLIENT_CAPABILITIES, PROTOCOL_VERSION, type AcpChild } from '../acp/acp-client';
import { modelConfigId, toEffort, toModels, type ConfigOption } from '../acp/config-options';
import { AcpRun } from '../acp/acp-run';
import { openCodeModeId } from './map-modes';
import { openCodeTools } from './map-tools';
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

/**
 * `shell: true` is not optional on Windows: `opencode` resolves to a `.cmd`
 * shim, and Node 22 refuses to spawn one directly (EINVAL) since the
 * command-injection hardening in 20.x.
 */
export function spawnOpenCodeAcp(binPath?: string, env?: NodeJS.ProcessEnv): AcpChild {
  const bin = binPath ?? 'opencode';
  const child = spawnChildProcess(bin, ['acp'], {
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
  private readonly spawn: (bin: string, env?: NodeJS.ProcessEnv) => AcpChild;
  private readonly selfControlMcp?: SelfControlMcpConfig;
  /** Instance env override, merged into every spawned `opencode acp` process's env. */
  private readonly env?: NodeJS.ProcessEnv;
  private readonly execVersion?: ExecVersionFn;
  private readonly fetchLatest?: FetchFn;
  /** Test-only override for `CONFIG_OPTION_TIMEOUT_MS` — see `probe`. */
  private readonly configOptionTimeoutMs: number;

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
    spawn?: (bin: string, env?: NodeJS.ProcessEnv) => AcpChild;
    selfControlMcp?: SelfControlMcpConfig;
    env?: NodeJS.ProcessEnv;
    loginKind?: 'oauth' | 'none';
    execVersion?: ExecVersionFn;
    fetchLatest?: FetchFn;
    configOptionTimeoutMs?: number;
  } = {}) {
    this.id = opts.id ?? 'opencode';
    this.displayName = opts.displayName ?? 'OpenCode';
    this.binPath = opts.binPath;
    this.spawn = opts.spawn ?? ((bin, env) => spawnOpenCodeAcp(bin, env));
    this.selfControlMcp = opts.selfControlMcp;
    this.env = opts.env;
    this.loginKind = opts.loginKind;
    this.execVersion = opts.execVersion;
    this.fetchLatest = opts.fetchLatest;
    this.configOptionTimeoutMs = opts.configOptionTimeoutMs ?? CONFIG_OPTION_TIMEOUT_MS;
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
    const child = this.spawn(this.binPath ?? 'opencode', this.mergedEnv());
    return new AcpRun(child, {
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
    });
  }
}
