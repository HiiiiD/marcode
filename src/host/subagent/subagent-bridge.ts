import type { AgentSession } from '../agent-session';
import type { AgentEvent } from '../../providers/types';
import { mirrorId } from './mirror-ids';

export interface SubagentResult { ok: boolean; text: string; sessionId: string; cancelled?: boolean; detached?: boolean }

export const EMPTY_REPLY = '(subagent finished with no output)';

interface BridgeOptions {
  parent: AgentSession;
  child: AgentSession;
  cardId: string;
  prompt: string;
  /** What the child is actually sent, when it differs from the prompt shown on the card. */
  message?: string;
  background?: boolean;
  /** Fired when the pending-approval count or the settled state changes. */
  onChange?: () => void;
  /** Deny an approval nobody answered within this long (background children only). */
  approvalTimeoutMs?: number;
}

/** Mirrors one hosted child's events into its parent as a nested `subagent` card. */
export class SubagentBridge {
  private readonly parent: AgentSession;
  private readonly child: AgentSession;
  private readonly cardId: string;
  private readonly prompt: string;
  private readonly message: string;
  private readonly background: boolean;
  private readonly onChange: (() => void) | undefined;
  private readonly approvalTimeoutMs: number | undefined;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private reply = '';
  private settled = false;
  private readonly openRequests = new Set<string>();
  private resolveResult!: (r: SubagentResult) => void;
  private readonly done = new Promise<SubagentResult>((resolve) => { this.resolveResult = resolve; });

  constructor(o: BridgeOptions) {
    this.parent = o.parent;
    this.child = o.child;
    this.cardId = o.cardId;
    this.prompt = o.prompt;
    this.message = o.message ?? o.prompt;
    this.background = o.background ?? false;
    this.onChange = o.onChange;
    this.approvalTimeoutMs = o.approvalTimeoutMs;
  }

  pendingApprovals(): number { return this.openRequests.size; }

  result(): Promise<SubagentResult> { return this.done; }

  start(): void {
    const { name, model } = this.child.state;
    this.parent.ingestNested({
      kind: 'tool-start', id: this.cardId,
      tool: {
        kind: 'subagent', label: 'Subagent', action: 'spawn', agent: name, model, sessionId: this.child.state.id,
        prompt: this.prompt,
      },
    });
    this.child.setTap((event) => this.onChildEvent(event));
    this.child.send(this.message);
  }

  cancel(): void {
    if (this.settled) { return; }
    this.finish(false, 'Subagent cancelled', { cancelled: true });
    void this.child.interrupt();
  }

  /** The child was promoted to its own session: stop mirroring and let it run on. */
  detach(): void {
    this.finish(
      true,
      `Opened as its own session "${this.child.state.name}". It keeps running there; its reply is no longer returned here.`,
      { detached: true },
    );
  }

  private onChildEvent(event: AgentEvent): void {
    if (this.settled) { return; }
    const parentId = this.cardId;
    const id = (raw: string) => mirrorId(this.child.state.id, raw);
    switch (event.kind) {
      case 'text':
        this.reply += event.delta;
        return;
      case 'tool-start':
        this.reply = '';
        this.parent.ingestNested({ ...event, id: id(event.id), parentId });
        return;
      case 'tool-update':
      case 'tool-end':
        this.parent.ingestNested({ ...event, id: id(event.id), parentId });
        return;
      case 'permission': {
        const mirrored = id(event.id);
        this.openRequests.add(mirrored);
        this.parent.ingestNested({ ...event, id: mirrored, parentId }, {
          onDecision: (decision) => {
            this.openRequests.delete(mirrored);
            this.clearTimer(mirrored);
            this.child.respondToPermission(event.id, decision);
            this.onChange?.();
          },
        });
        this.watchApproval(mirrored, () => {
          this.parent.respondToPermission(mirrored, { allow: false, reason: 'Approval timed out' });
        });
        this.onChange?.();
        return;
      }
      case 'question': {
        const mirrored = id(event.id);
        this.openRequests.add(mirrored);
        this.parent.ingestNested({ ...event, id: mirrored }, {
          onAnswer: (answers) => {
            this.openRequests.delete(mirrored);
            this.clearTimer(mirrored);
            this.child.answerQuestion(event.id, answers);
            this.onChange?.();
          },
          onCancel: () => this.cancel(),
        });
        this.watchApproval(mirrored, () => {
          void this.child.interrupt();
          this.finish(false, 'Subagent blocked: a question went unanswered');
        });
        this.onChange?.();
        return;
      }
      case 'request-cancelled':
        this.clearTimer(id(event.id));
        this.openRequests.delete(id(event.id));
        this.parent.ingestNested({ ...event, id: id(event.id) });
        this.onChange?.();
        return;
      case 'turn-end':
        if (event.reason === 'done') { this.finish(true, this.reply.trim() || EMPTY_REPLY); }
        else if (event.reason === 'interrupted') { this.finish(false, 'Subagent interrupted'); }
        else { this.finish(false, event.error ?? 'Subagent failed'); }
        return;
      default:
        return;
    }
  }

  private watchApproval(mirrored: string, onTimeout: () => void): void {
    if (this.approvalTimeoutMs === undefined) { return; }
    const timer = setTimeout(() => { this.timers.delete(mirrored); onTimeout(); }, this.approvalTimeoutMs);
    timer.unref();
    this.timers.set(mirrored, timer);
  }

  private clearTimer(mirrored: string): void {
    const timer = this.timers.get(mirrored);
    if (timer) { clearTimeout(timer); this.timers.delete(mirrored); }
  }

  private finish(ok: boolean, text: string, flags: { cancelled?: boolean; detached?: boolean } = {}): void {
    if (this.settled) { return; }
    this.settled = true;
    for (const timer of this.timers.values()) { clearTimeout(timer); }
    this.timers.clear();
    this.child.setTap(undefined);
    for (const mirrored of this.openRequests) {
      this.parent.ingestNested({ kind: 'request-cancelled', id: mirrored });
    }
    this.openRequests.clear();
    this.parent.ingestNested({ kind: 'tool-end', id: this.cardId, ok, output: { kind: 'text', text } });
    this.resolveResult({ ok, text, sessionId: this.child.state.name, ...flags });
  }
}
