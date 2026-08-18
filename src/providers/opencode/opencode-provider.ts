import { spawn as spawnChildProcess } from 'node:child_process';
import { connectAcp, CLIENT_CAPABILITIES, PROTOCOL_VERSION, type AcpChild } from '../acp/acp-client';
import { toModels, type ConfigOption } from '../acp/config-options';
import { AcpRun } from '../acp/acp-run';
import { openCodeModeId } from './map-modes';
import { openCodeTools } from './map-tools';
import type {
  AgentProvider, AgentRun, ModelInfo, PermissionModeInfo, StartOptions, ThreadScope,
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
  closeSession(params: unknown): Promise<unknown>;
}

/**
 * `shell: true` is not optional on Windows: `opencode` resolves to a `.cmd`
 * shim, and Node 22 refuses to spawn one directly (EINVAL) since the
 * command-injection hardening in 20.x.
 */
export function spawnOpenCodeAcp(binPath?: string): AcpChild {
  const bin = binPath ?? 'opencode';
  const child = spawnChildProcess(bin, ['acp'], {
    stdio: ['pipe', 'pipe', 'pipe'], shell: true, windowsHide: true,
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
  readonly id = 'opencode';
  readonly displayName = 'OpenCode';
  /**
   * Measured on 1.18.18: a `session/load` from a directory other than the one
   * that created the session replays the full history and then never answers.
   * Relocation therefore reseeds by replay rather than resuming natively.
   */
  readonly threadScope: ThreadScope = 'cwd';

  private models: ModelInfo[] = [];
  private readonly binPath?: string;
  private readonly spawn: (bin: string) => AcpChild;

  /**
   * Deliberately never assigned. ACP carries no plan-usage data, so this
   * provider has nothing to poll and omits `fetchUsage` the same way a
   * provider with no plan limits at all is meant to — see the interface's
   * own doc. Declared (not simply left off the class) so `listModels()`'s
   * sibling optional-member callers, and this provider's own tests, can read
   * `provider.fetchUsage` and see `undefined` rather than a compile error.
   */
  readonly fetchUsage?: AgentProvider['fetchUsage'];

  constructor(opts: { binPath?: string; spawn?: (bin: string) => AcpChild } = {}) {
    this.binPath = opts.binPath;
    this.spawn = opts.spawn ?? ((bin) => spawnOpenCodeAcp(bin));
  }

  listModels(): ModelInfo[] { return this.models; }
  listPermissionModes(): PermissionModeInfo[] { return OPENCODE_MODES; }

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
      child = this.spawn(this.binPath ?? 'opencode');
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
    this.models = toModels(session.configOptions ?? []);
    try {
      await connection.closeSession({ sessionId: session.sessionId });
    } catch {
      // Best effort. A probe session left open is untidy, not broken —
      // and never a reason to report the provider as unavailable.
    }
    return this.models;
  }

  start(opts: StartOptions): AgentRun {
    const child = this.spawn(this.binPath ?? 'opencode');
    return new AcpRun(child, {
      cwd: opts.cwd,
      model: opts.model,
      permissionMode: opts.permissionMode,
      resumeToken: opts.resumeToken,
      tools: openCodeTools,
      modeId: openCodeModeId,
      clientName: 'mar-code',
    });
  }
}
