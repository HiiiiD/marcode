import type { AgentSession } from '../agent-session';
import type { ResolvedSpawn } from '../self-control/spawn-support';
import type { SessionId } from '../../protocol/messages';
import { SubagentBridge, type SubagentResult } from './subagent-bridge';
import { buildSubagentPreamble } from './subagent-preamble';

export interface SubagentHost {
  get(id: SessionId): AgentSession | undefined;
  createSubagent(parent: SessionId, spec: ResolvedSpawn): Promise<AgentSession>;
  releaseSubagent(id: SessionId): Promise<void>;
  changed(): void;
}

interface Entry { bridge: SubagentBridge; childId: SessionId; promoted?: boolean }

const failure = (text: string): SubagentResult => ({ ok: false, text, sessionId: '' });
const handleKey = (parentId: SessionId, name: string) => `${parentId}\n${name.toLowerCase()}`;

export const SUBAGENT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** Runs hosted children for their parents and tracks who is running under whom. */
export class SubagentService {
  private readonly byParent = new Map<SessionId, Set<Entry>>();
  private readonly handles = new Map<string, Promise<SubagentResult>>();
  /** How long a background child may wait on an unanswered approval before it is denied. */
  approvalTimeoutMs = SUBAGENT_APPROVAL_TIMEOUT_MS;

  constructor(private readonly host: SubagentHost) {}

  running(parentId: SessionId): number { return this.byParent.get(parentId)?.size ?? 0; }

  counts(parentId: SessionId): { running: number; awaitingApproval: number } | undefined {
    const entries = this.byParent.get(parentId);
    if (!entries || entries.size === 0) { return undefined; }
    let awaiting = 0;
    for (const e of entries) { awaiting += e.bridge.pendingApprovals(); }
    return { running: entries.size, awaitingApproval: awaiting };
  }

  private cancelChild(parentId: SessionId, childId: SessionId): void {
    for (const entry of this.byParent.get(parentId) ?? []) {
      if (entry.childId !== childId) { continue; }
      this.cancelSubtree(childId);
      entry.bridge.cancel();
    }
  }

  cancelSubtree(parentId: SessionId): void {
    for (const entry of [...(this.byParent.get(parentId) ?? [])]) {
      this.cancelSubtree(entry.childId);
      entry.bridge.cancel();
    }
  }

  /** Foreground: resolves with the child's final reply. */
  async run(
    parentId: SessionId, spec: ResolvedSpawn, prompt: string, opts: { signal?: AbortSignal } = {},
  ): Promise<SubagentResult> {
    const launched = await this.launch(parentId, spec, prompt, false);
    if (!launched.ok) { return launched.result; }
    const { signal } = opts;
    if (signal) {
      const abort = () => this.cancelChild(parentId, launched.child.state.id);
      if (signal.aborted) { abort(); } else { signal.addEventListener('abort', abort, { once: true }); }
      void launched.settled.then(() => signal.removeEventListener('abort', abort));
    }
    return launched.settled;
  }

  /** Background: resolves as soon as the child is running; the reply is delivered to the parent as a message. */
  async runBackground(
    parentId: SessionId, spec: ResolvedSpawn, prompt: string,
  ): Promise<{ ok: true; sessionId: string } | { ok: false; text: string }> {
    const launched = await this.launch(parentId, spec, prompt, true);
    if (!launched.ok) { return { ok: false, text: launched.result.text }; }
    const { parent, child, settled } = launched;
    this.handles.set(handleKey(parentId, child.state.name), settled);
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
    const timeout = new Promise<'pending'>((resolve) => { timer = setTimeout(() => resolve('pending'), timeoutMs); });
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

  forget(parentId: SessionId): void {
    for (const key of [...this.handles.keys()]) {
      if (key.startsWith(`${parentId}\n`)) { this.handles.delete(key); }
    }
  }

  private async launch(
    parentId: SessionId, spec: ResolvedSpawn, prompt: string, background: boolean,
  ): Promise<
    { ok: false; result: SubagentResult }
    | { ok: true; parent: AgentSession; child: AgentSession; settled: Promise<SubagentResult> }
  > {
    const parent = this.host.get(parentId);
    if (!parent) { return { ok: false, result: failure('The calling session is not live.') }; }
    let child: AgentSession;
    try {
      child = await this.host.createSubagent(parentId, spec);
    } catch (err) {
      return { ok: false, result: failure(err instanceof Error ? err.message : String(err)) };
    }
    const bridge = new SubagentBridge({
      parent, child, cardId: `sub-${child.state.id}`, prompt, background,
      message: `${buildSubagentPreamble({ parent: parent.state.name })}\n\n${prompt}`,
      onChange: () => this.host.changed(),
      approvalTimeoutMs: background ? this.approvalTimeoutMs : undefined,
    });
    const entry: Entry = { bridge, childId: child.state.id };
    const set = this.byParent.get(parentId) ?? new Set<Entry>();
    set.add(entry);
    this.byParent.set(parentId, set);
    const unlisten = parent.onInterrupt(() => bridge.cancel());
    this.host.changed();
    bridge.start();
    const settled = bridge.result().then(async (result) => {
      unlisten();
      set.delete(entry);
      if (set.size === 0) { this.byParent.delete(parentId); }
      this.host.changed();
      if (!entry.promoted) { await this.host.releaseSubagent(child.state.id).catch(() => undefined); }
      return result;
    });
    return { ok: true, parent, child, settled };
  }
}
