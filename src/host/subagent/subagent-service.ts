import type { AgentSession } from '../agent-session';
import type { ResolvedSpawn } from '../self-control/spawn-support';
import type { SessionId } from '../../protocol/messages';
import { SubagentBridge, type SubagentResult } from './subagent-bridge';
import { buildSubagentPreamble } from './subagent-preamble';

export interface SubagentHost {
  get(id: SessionId): AgentSession | undefined;
  createSubagent(parent: SessionId, spec: ResolvedSpawn): Promise<AgentSession>;
  releaseSubagent(id: SessionId): Promise<void>;
  removeSubagent(id: SessionId): Promise<void>;
  changed(): void;
}

interface Entry { bridge: SubagentBridge; childId: SessionId; promoted?: boolean }

const handleKey = (parentId: SessionId, name: string) => `${parentId}\n${name.toLowerCase()}`;

export const SUBAGENT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** Runs hosted children for their parents and tracks who is running under whom. */
export class SubagentService {
  private readonly byParent = new Map<SessionId, Set<Entry>>();
  private readonly handles = new Map<string, Promise<SubagentResult>>();
  /** How long a background child may wait on an unanswered approval before it is denied. */
  approvalTimeoutMs = SUBAGENT_APPROVAL_TIMEOUT_MS;
  /** Background results kept for `awaitResult`, newest last; older ones are dropped. */
  maxHandles = 200;
  private readonly releases = new Map<SessionId, Promise<void>>();

  constructor(private readonly host: SubagentHost) {}

  running(parentId: SessionId): number { return this.byParent.get(parentId)?.size ?? 0; }

  counts(parentId: SessionId): { running: number; awaitingApproval: number } | undefined {
    const entries = this.byParent.get(parentId);
    if (!entries || entries.size === 0) { return undefined; }
    let awaiting = 0;
    for (const e of entries) { awaiting += e.bridge.pendingApprovals(); }
    return { running: entries.size, awaitingApproval: awaiting };
  }

  cancelSubtree(parentId: SessionId): void {
    for (const entry of [...(this.byParent.get(parentId) ?? [])]) {
      this.cancelSubtree(entry.childId);
      entry.bridge.cancel();
    }
  }

  /** Creates the hidden child without running it, so a team can learn each other's names first. */
  async prepare(
    parentId: SessionId, spec: ResolvedSpawn,
  ): Promise<{ ok: true; child: AgentSession } | { ok: false; text: string }> {
    if (!this.host.get(parentId)) { return { ok: false, text: 'The calling session is not live.' }; }
    try {
      return { ok: true, child: await this.host.createSubagent(parentId, spec) };
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Drops a prepared child that will never run. */
  async discard(childId: SessionId): Promise<void> {
    await this.host.removeSubagent(childId).catch(() => undefined);
  }

  /** Resolves as soon as the child is running; the reply is delivered to the parent as a message. */
  async runBackground(
    parentId: SessionId, spec: ResolvedSpawn, prompt: string, opts: { seed?: string } = {},
  ): Promise<{ ok: true; sessionId: string } | { ok: false; text: string }> {
    const prepared = await this.prepare(parentId, spec);
    if (!prepared.ok) { return prepared; }
    return this.start(parentId, prepared.child, prompt, opts.seed);
  }

  /** Runs a prepared child. `seed` is hidden context; it defaults to "you were delegated this". */
  start(
    parentId: SessionId, child: AgentSession, prompt: string, seed?: string,
  ): { ok: true; sessionId: string } | { ok: false; text: string } {
    const parent = this.host.get(parentId);
    if (!parent) { return { ok: false, text: 'The calling session is not live.' }; }
    const settled = this.begin(parent, child, prompt, seed ?? buildSubagentPreamble({ parent: parent.state.name }));
    this.handles.set(handleKey(parentId, child.state.name), settled);
    while (this.handles.size > this.maxHandles) {
      const oldest = this.handles.keys().next().value;
      if (oldest === undefined) { break; }
      this.handles.delete(oldest);
    }
    void settled.then((result) => {
      if (result.cancelled || result.detached) { return; }
      const verdict = result.ok ? 'finished' : 'failed';
      try {
        parent.send(
          `Subagent "${child.state.name}" ${verdict}:\n${result.text}`,
          undefined, undefined, undefined, { sessionId: child.state.id, name: child.state.name },
        );
      } catch { /* the parent went away; the card already holds the result */ }
    });
    return { ok: true, sessionId: child.state.name };
  }

  /** `undefined`: no such handle. `'pending'`: still running when the wait ran out. */
  async awaitResult(parentId: SessionId, name: string, timeoutMs: number): Promise<SubagentResult | 'pending' | undefined> {
    const settled = this.handles.get(handleKey(parentId, name));
    if (!settled) { return undefined; }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => resolve('pending'), timeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([settled, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stops mirroring `childId` into its parent without stopping the child; true if it was running. */
  detach(childId: SessionId): boolean {
    for (const entries of this.byParent.values()) {
      for (const entry of entries) {
        if (entry.childId !== childId) { continue; }
        entry.promoted = true;
        entry.bridge.detach();
        return true;
      }
    }
    return false;
  }

  /** A release that has started and not finished; promote waits on it so it never shows a half-disposed child. */
  pendingRelease(childId: SessionId): Promise<void> | undefined { return this.releases.get(childId); }

  forget(parentId: SessionId): void {
    for (const key of [...this.handles.keys()]) {
      if (key.startsWith(`${parentId}\n`)) { this.handles.delete(key); }
    }
  }

  private begin(parent: AgentSession, child: AgentSession, prompt: string, seed: string): Promise<SubagentResult> {
    const parentId = parent.state.id;
    child.setSeed(seed);
    const bridge = new SubagentBridge({
      parent, child, cardId: `sub-${child.state.id}`, prompt,
      onChange: () => this.host.changed(),
      approvalTimeoutMs: this.approvalTimeoutMs,
    });
    const entry: Entry = { bridge, childId: child.state.id };
    const set = this.byParent.get(parentId) ?? new Set<Entry>();
    set.add(entry);
    this.byParent.set(parentId, set);
    const unlisten = parent.onInterrupt(() => bridge.cancel());
    this.host.changed();
    bridge.start();
    return bridge.result().then(async (result) => {
      unlisten();
      set.delete(entry);
      if (set.size === 0) { this.byParent.delete(parentId); }
      this.host.changed();
      if (!entry.promoted) {
        const release = this.host.releaseSubagent(child.state.id).catch(() => undefined);
        this.releases.set(child.state.id, release);
        await release;
        this.releases.delete(child.state.id);
      }
      return result;
    });
  }
}
