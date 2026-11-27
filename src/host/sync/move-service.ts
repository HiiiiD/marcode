import { randomBytes } from 'node:crypto';
import type { SessionId, SessionState } from '../../protocol/messages';
import { readCredentials, type SyncCredentials } from '../../sync/credentials';
import type { MoveReplyPayload } from '../../sync/move-records';
import { ownerKey } from '../../sync/owner-key';
import { SyncClient, type SyncClientOptions } from '../../sync/sync-client';
import type { SyncState } from '../../sync/sync-state';
import type { ProjectResolver } from '../project/project-resolver';
import type { SessionManager } from '../session-manager';
import { checkoutsFor, ensureWorktree } from './checkouts';
import { materialize } from './materialize';
import { readInbox, readRemoteRoster, readThread, removeInbox } from './remote-roster';

export type MoveStatus =
  | { state: 'waiting'; step: 'reply' | 'transcript' | 'claim' | 'thread' }
  | { state: 'done'; sessionId: SessionId; thread: 'restored' | 'restarted' }
  | { state: 'failed'; reason: string };

export type MoveTarget = { root: string } | { createWorktree: string };

export interface MoveServiceDeps {
  manager: SessionManager;
  state: SyncState;
  home: string;
  mirrorRoot: string;
  roots: () => string[];
  projects: ProjectResolver;
  takeOverAfterMs: number;
  replyTimeoutMs?: number;
  mirrorTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  client?: (creds: SyncCredentials) => SyncClient;
  clientOptions?: SyncClientOptions;
}

class MoveFailed extends Error {}

const pad = (n: number): string => String(n).padStart(2, '0');
const clock = (ts: number): string => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** The target half of a move: asks the owner for a session, or takes it over, and makes it local here. */
export class MoveService {
  constructor(private readonly deps: MoveServiceDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }

  canTakeOver(id: SessionId): boolean {
    const remote = this.deps.manager.remoteRow(id)?.remote;
    return remote !== undefined && !remote.online && this.now() - remote.lastSeenAt >= this.deps.takeOverAfterMs;
  }

  async moveHere(id: SessionId, target: MoveTarget, opts: { cancelTurn: boolean }, onStatus: (s: MoveStatus) => void): Promise<void> {
    await this.run(onStatus, async () => {
      const row = this.row(id);
      const root = await this.targetRoot(row, target);
      const creds = await this.creds();
      const requestId = randomBytes(12).toString('hex');
      this.deps.state.enqueue({ type: 'move-request', v: 1, sessionId: id, requestId, to: creds.deviceId, cancelTurn: opts.cancelTurn });
      onStatus({ state: 'waiting', step: 'reply' });
      const reply = await this.awaitReply(requestId, row);
      if (!reply.ok) { throw new MoveFailed(reply.reason); }
      onStatus({ state: 'waiting', step: 'transcript' });
      await this.awaitMirror(row, reply.lastRev, reply.thread?.generation);
      onStatus({ state: 'waiting', step: 'claim' });
      await this.claim(creds, row, reply.lastRev);
      onStatus({ state: 'waiting', step: 'thread' });
      return this.finish(row, root, `Moved here from ${row.remote!.deviceName}.`);
    });
  }

  async takeOver(id: SessionId, target: MoveTarget, onStatus: (s: MoveStatus) => void): Promise<void> {
    await this.run(onStatus, async () => {
      const row = this.row(id);
      if (!this.canTakeOver(id)) { throw new MoveFailed(`${row.remote!.deviceName} was seen too recently to take this session over.`); }
      const root = await this.targetRoot(row, target);
      const creds = await this.creds();
      const mirrored = (await readRemoteRoster(this.deps.mirrorRoot)).rows.find((r) => r.deviceId === row.remote!.deviceId && r.state.id === id);
      onStatus({ state: 'waiting', step: 'claim' });
      await this.claim(creds, row, mirrored?.rev ?? 0);
      onStatus({ state: 'waiting', step: 'thread' });
      return this.finish(row, root, `Taken over from ${row.remote!.deviceName} (last seen ${clock(row.remote!.lastSeenAt)}).`);
    });
  }

  private async run(onStatus: (s: MoveStatus) => void, work: () => Promise<{ sessionId: SessionId; thread: 'restored' | 'restarted' }>): Promise<void> {
    try {
      onStatus({ state: 'done', ...(await work()) });
    } catch (err) {
      onStatus({ state: 'failed', reason: err instanceof MoveFailed ? err.message : `The move failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private row(id: SessionId): SessionState {
    const row = this.deps.manager.remoteRow(id);
    if (!row?.remote) { throw new MoveFailed('This session is not on another device.'); }
    if (!this.deps.manager.hasProvider(row.providerId)) { throw new MoveFailed(`This device has no ${row.providerId} provider, so the session cannot run here.`); }
    return row;
  }

  private async creds(): Promise<SyncCredentials> {
    const creds = await readCredentials(this.deps.home);
    if (!creds) { throw new MoveFailed('This device is not paired.'); }
    return creds;
  }

  private async targetRoot(row: SessionState, target: MoveTarget): Promise<string> {
    if ('root' in target) { return target.root; }
    const main = (await checkoutsFor(row.projectId ?? '', this.deps.roots(), this.deps.projects)).find((c) => c.main);
    if (!main) { throw new MoveFailed('No checkout of this project is open here to add a worktree to.'); }
    const made = await ensureWorktree(main.root, target.createWorktree);
    if (!made.ok) { throw new MoveFailed(made.reason); }
    return made.root;
  }

  private async until<T>(ms: number, probe: () => Promise<T | undefined>): Promise<T | undefined> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value !== undefined || Date.now() > deadline) { return value; }
      await new Promise((r) => setTimeout(r, this.deps.pollMs ?? 250));
    }
  }

  private async awaitReply(requestId: string, row: SessionState): Promise<MoveReplyPayload> {
    const reply = await this.until(this.deps.replyTimeoutMs ?? 5 * 60_000, async () =>
      (await readInbox(this.deps.mirrorRoot)).find((m) => m.payload.type === 'move-reply' && m.payload.requestId === requestId)?.payload as MoveReplyPayload | undefined);
    await removeInbox(this.deps.mirrorRoot, requestId);
    if (!reply) { throw new MoveFailed(`${row.remote!.deviceName} did not answer. Is it running Marcode and online?`); }
    return reply;
  }

  private async awaitMirror(row: SessionState, lastRev: number, generation: number | undefined): Promise<void> {
    const deviceId = row.remote!.deviceId;
    const ready = await this.until(this.deps.mirrorTimeoutMs ?? 2 * 60_000, async () => {
      const mirrored = (await readRemoteRoster(this.deps.mirrorRoot)).rows.find((r) => r.deviceId === deviceId && r.state.id === row.id);
      if (!mirrored || mirrored.rev < lastRev) { return undefined; }
      if (generation === undefined) { return true; }
      const files = await readThread(this.deps.mirrorRoot, deviceId, row.id);
      return files?.every((f) => f.generation >= generation) ? true : undefined;
    });
    if (!ready) { throw new MoveFailed(`The transcript from ${row.remote!.deviceName} did not arrive in time.`); }
  }

  private async claim(creds: SyncCredentials, row: SessionState, baseRev: number): Promise<void> {
    const client = this.deps.client?.(creds) ?? new SyncClient(creds, this.deps.clientOptions);
    const owners = await client.owners();
    if (!owners.ok) { throw new MoveFailed(`Cannot reach the sync server, so nothing moved: ${owners.error}`); }
    const expect = owners.value.find((o) => o.key === ownerKey(creds, row.id))?.epoch ?? 0;
    const won = await client.claimOwner(row.id, { epoch: expect + 1, expect, baseRev });
    if (!won.ok) { throw new MoveFailed(`Cannot reach the sync server, so nothing moved: ${won.error}`); }
    if ('conflict' in won.value) {
      const winner = won.value.conflict.deviceId === row.remote!.deviceId ? row.remote!.deviceName : 'another device';
      throw new MoveFailed(`Moved to ${winner} by another request.`);
    }
  }

  private async finish(row: SessionState, root: string, lead: string): Promise<{ sessionId: SessionId; thread: 'restored' | 'restarted' }> {
    const { state: next, items, seed, thread } = await materialize({
      row, root, mirrorRoot: this.deps.mirrorRoot, provider: this.deps.manager.providerOf(row.providerId),
    });
    const notice = thread === 'restored'
      ? `${lead} Agent thread restored.`
      : `${lead} The agent restarted from the transcript; earlier tool output is not in its context.`;
    if (row.projectId) { this.deps.state.setLastCheckout(row.projectId, root); }
    await this.deps.manager.adoptMoved({ state: next, items, ...(seed ? { seed } : {}), notice });
    return { sessionId: row.id, thread };
  }
}
