import type { SessionId, SessionStatus } from '../protocol/messages';
import type { NotificationKinds } from '../shared/notification-settings';

export type NotifyKind = keyof NotificationKinds;

export interface NotifierPorts {
  isWatching(id: SessionId): boolean;
  nameOf(id: SessionId): string;
  kinds(): NotificationKinds;
  /** Why an `awaiting-approval` session is blocked; a permission outranks a question. */
  waitingOn(id: SessionId): 'approval' | 'question';
  show(id: SessionId, kind: NotifyKind, name: string): void;
  setPendingCount(count: number): void;
  now?(): number;
  coalesceMs?: number;
}

const DEFAULT_COALESCE_MS = 5000;

export class Notifier {
  private readonly last = new Map<SessionId, SessionStatus>();
  private readonly lastShown = new Map<SessionId, number>();
  private readonly awaiting = new Set<SessionId>();

  constructor(private readonly ports: NotifierPorts) {}

  onStatus(id: SessionId, status: SessionStatus): void {
    const prev = this.last.get(id);
    this.last.set(id, status);
    if (prev === status) { return; }

    const wasAwaiting = this.awaiting.has(id);
    if (status === 'awaiting-approval') { this.awaiting.add(id); } else { this.awaiting.delete(id); }
    if (wasAwaiting !== this.awaiting.has(id)) { this.ports.setPendingCount(this.awaiting.size); }

    const kind = status === 'awaiting-approval' ? this.ports.waitingOn(id) : kindFor(prev, status);
    if (kind === undefined || !this.ports.kinds()[kind] || this.ports.isWatching(id)) { return; }

    const now = (this.ports.now ?? Date.now)();
    const shownAt = this.lastShown.get(id);
    if (shownAt !== undefined && now - shownAt < (this.ports.coalesceMs ?? DEFAULT_COALESCE_MS)) { return; }
    this.lastShown.set(id, now);
    this.ports.show(id, kind, this.ports.nameOf(id));
  }

  retain(ids: Iterable<SessionId>): void {
    const keep = new Set(ids);
    for (const id of [...this.last.keys()]) { if (!keep.has(id)) { this.forget(id); } }
  }

  forget(id: SessionId): void {
    this.last.delete(id);
    this.lastShown.delete(id);
    if (this.awaiting.delete(id)) { this.ports.setPendingCount(this.awaiting.size); }
  }
}

function kindFor(prev: SessionStatus | undefined, next: SessionStatus): NotifyKind | undefined {
  if (next === 'error') { return 'error'; }
  if (next === 'idle' && prev === 'running') { return 'finished'; }
  return undefined;
}
