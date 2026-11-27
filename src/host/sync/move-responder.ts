import type { SessionId, SessionState } from '../../protocol/messages';
import type { MoveReplyPayload, MoveRequestPayload } from '../../sync/move-records';
import type { SyncState } from '../../sync/sync-state';
import { pushedState } from '../project/checkout-state';
import { readInbox, removeInbox } from './remote-roster';
import type { SessionPublisher } from './session-publisher';
import type { ThreadPublisher } from './thread-publisher';

export interface MoveSource {
  publishableSession(id: SessionId): SessionState | undefined;
  moveBlocker(id: SessionId): 'subagents' | 'side' | undefined;
  finishTurn(id: SessionId, cancel: boolean): Promise<boolean>;
  yieldSession(id: SessionId): Promise<void>;
  unyield(id: SessionId): Promise<void>;
  isYielded(id: SessionId): boolean;
}

export interface MoveResponderDeps {
  manager: MoveSource;
  state: SyncState;
  sessions: SessionPublisher;
  threads: ThreadPublisher;
  mirrorRoot: string;
  deviceName: string;
  pollMs?: number;
  /** How long a handed-over session waits for the other device to claim it before this host takes it back. */
  claimTimeoutMs?: number;
}

/** The source half of a move: answers other devices' requests for sessions this host owns. */
export class MoveResponder {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private readonly handled = new Set<string>();
  private readonly reclaim = new Map<SessionId, NodeJS.Timeout>();

  constructor(private readonly deps: MoveResponderDeps) {}

  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, this.deps.pollMs ?? 2000);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); }
    for (const t of this.reclaim.values()) { clearTimeout(t); }
    this.reclaim.clear();
  }

  private async tick(): Promise<void> {
    if (this.busy) { return; }
    this.busy = true;
    try {
      for (const { payload } of await readInbox(this.deps.mirrorRoot)) {
        if (payload.type !== 'move-request' || this.handled.has(payload.requestId)) { continue; }
        // Another host on this machine may own it; that host answers.
        if (!this.deps.manager.publishableSession(payload.sessionId)) { continue; }
        this.handled.add(payload.requestId);
        await this.answer(payload).catch((err: unknown) => { console.error('[mar-code] sync: move request failed', err); });
        await removeInbox(this.deps.mirrorRoot, payload.requestId);
      }
    } catch (err) {
      console.error('[mar-code] sync: move inbox unreadable', err);
    } finally {
      this.busy = false;
    }
  }

  private reply(request: MoveRequestPayload, body: { ok: true; lastRev: number; thread?: { generation: number; bytes: number } } | { ok: false; reason: string }): void {
    const reply = { type: 'move-reply', v: 1, sessionId: request.sessionId, requestId: request.requestId, ...body } as MoveReplyPayload;
    this.deps.state.enqueue(reply);
  }

  private async answer(request: MoveRequestPayload): Promise<void> {
    const { manager, deviceName } = this.deps;
    const id = request.sessionId;
    const blocker = manager.moveBlocker(id);
    if (blocker) {
      this.reply(request, { ok: false, reason: blocker === 'subagents' ? `This session has running subagents on ${deviceName}.` : `This session has an open side chat on ${deviceName}.` });
      return;
    }
    const state = manager.publishableSession(id);
    if (!state) { return; }
    const pushed = await pushedState(state.cwd);
    if (!pushed.upstream) { this.reply(request, { ok: false, reason: `Push your changes on ${deviceName} first: this branch has no upstream.` }); return; }
    if (pushed.modified > 0 || pushed.unpushed > 0) {
      this.reply(request, { ok: false, reason: `Push your changes on ${deviceName} first: ${pushed.modified} modified files, ${pushed.unpushed} unpushed commits.` });
      return;
    }
    if (!(await manager.finishTurn(id, request.cancelTurn))) {
      this.reply(request, { ok: false, reason: `The turn running on ${deviceName} did not finish in time.` });
      return;
    }
    // Flushed and read-only before the rev is read: nothing written after it could be missed by the target.
    await manager.yieldSession(id);
    await this.deps.sessions.settled(id);
    const thread = await this.deps.threads.turnEnded(id);
    this.reply(request, { ok: true, lastRev: this.deps.state.publishedRev(id), ...(thread ? { thread } : {}) });
    const timer = setTimeout(() => {
      this.reclaim.delete(id);
      if (manager.isYielded(id)) { void manager.unyield(id); }
    }, this.deps.claimTimeoutMs ?? 10 * 60_000);
    timer.unref();
    this.reclaim.set(id, timer);
  }
}
