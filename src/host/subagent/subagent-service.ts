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

interface Entry { bridge: SubagentBridge; childId: SessionId }

const failure = (text: string): SubagentResult => ({ ok: false, text, sessionId: '' });

/** Runs hosted children for their parents and tracks who is running under whom. */
export class SubagentService {
  private readonly byParent = new Map<SessionId, Set<Entry>>();

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

  async run(parentId: SessionId, spec: ResolvedSpawn, prompt: string): Promise<SubagentResult> {
    const parent = this.host.get(parentId);
    if (!parent) { return failure('The calling session is not live.'); }
    let child: AgentSession;
    try {
      child = await this.host.createSubagent(parentId, spec);
    } catch (err) {
      return failure(err instanceof Error ? err.message : String(err));
    }
    const bridge = new SubagentBridge({
      parent, child, cardId: `sub-${child.state.id}`, prompt,
      message: `${buildSubagentPreamble({ parent: parent.state.name })}\n\n${prompt}`,
    });
    const entry: Entry = { bridge, childId: child.state.id };
    const set = this.byParent.get(parentId) ?? new Set<Entry>();
    set.add(entry);
    this.byParent.set(parentId, set);
    const unlisten = parent.onInterrupt(() => bridge.cancel());
    this.host.changed();
    bridge.start();
    const result = await bridge.result();
    unlisten();
    set.delete(entry);
    if (set.size === 0) { this.byParent.delete(parentId); }
    this.host.changed();
    await this.host.releaseSubagent(child.state.id).catch(() => undefined);
    return result;
  }
}
