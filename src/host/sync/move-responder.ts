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
  attachmentFiles(id: SessionId): Promise<Array<{ attachmentId: string; name: string; mime: string; path: string }>>;
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
  selfDeviceId?: string;
  /** The server's owner record for a session, asked before taking a hand-over back. */
  ownerOf?: (sessionId: SessionId) => Promise<{ deviceId: string } | undefined>;
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
        const yielded = this.deps.manager.isYielded(payload.sessionId);
        // Another host on this machine may own it; that host answers.
        if (!yielded && !this.deps.manager.publishableSession(payload.sessionId)) { continue; }
        this.handled.add(payload.requestId);
        if (yielded) {
          this.reply(payload, { ok: false, reason: `${this.deps.deviceName} already handed this session to another device.` });
        } else {
          await this.answer(payload).catch((err: unknown) => { console.error('[mar-code] sync: move request failed', err); });
        }
        await removeInbox(this.deps.mirrorRoot, payload.requestId);
      }
    } catch (err) {
      console.error('[mar-code] sync: move inbox unreadable', err);
    } finally {
      this.busy = false;
    }
  }

  /** Unclaimed after the wait: back to this host, unless the server says another device holds it. */
  private async takeBack(id: SessionId): Promise<void> {
    if (!this.deps.manager.isYielded(id)) { return; }
    const record = await this.deps.ownerOf?.(id).catch(() => ({ deviceId: '?' }));
    if (record && record.deviceId !== this.deps.selfDeviceId) { return; }
    await this.deps.manager.unyield(id);
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
    // Ahead of the reply in this device's stream, so the target has them by the time it reads the reply.
    await this.deps.threads.attachments(id, await manager.attachmentFiles(id));
    // Uploaded while still ours: once yielded, the thread publisher no longer counts it as this host's.
    const thread = await this.deps.threads.turnEnded(id);
    // Flushed and read-only before the rev is read: nothing written after it could be missed by the target.
    await manager.yieldSession(id);
    await this.deps.sessions.settled(id);
    this.reply(request, { ok: true, lastRev: this.deps.state.publishedRev(id), ...(thread ? { thread } : {}) });
    const timer = setTimeout(() => {
      this.reclaim.delete(id);
      void this.takeBack(id);
    }, this.deps.claimTimeoutMs ?? 10 * 60_000);
    timer.unref();
    this.reclaim.set(id, timer);
  }
}
