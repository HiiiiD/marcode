import type { HostToWebview, SessionId, SessionSnapshot, WebviewToHost } from '../protocol/messages';

export interface VisibleHost {
  visibleIds(): SessionId[];
  setVisible(ids: SessionId[]): Promise<void>;
  snapshot(id: SessionId): Promise<SessionSnapshot | undefined>;
}

export interface ScopedRouter { handle(m: WebviewToHost): Promise<void>; dispose(): void }

const isIdList = (v: unknown): v is SessionId[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** The host keeps one visible set; each connection contributes its own panes and the host shows the union. */
export class VisibleSets {
  private readonly byConn = new Map<object, SessionId[]>();
  private frozen = false;

  constructor(private readonly host: VisibleHost) {}

  /** For shutdown: clients dropping one by one must not shrink the union while the host disposes. */
  freeze(): void { this.frozen = true; }

  scope(router: { handle(m: WebviewToHost): Promise<void> }, emit: (m: HostToWebview) => void): ScopedRouter {
    const key = {};
    let disposed = false;
    return {
      handle: async (m) => {
        if (m?.t !== 'set-visible') { await router.handle(m); return; }
        if (disposed || this.frozen || !isIdList(m.sessionIds)) { return; }
        // Already shown for another client, so the host emits no snapshot for it; this client still needs one.
        for (const id of await this.set(key, m.sessionIds)) {
          const session = await this.host.snapshot(id);
          if (session && !disposed) { emit({ t: 'session-snapshot', session }); }
        }
      },
      dispose: () => {
        disposed = true;
        // The last client leaving keeps the last union: a quit client must never trigger discard or digest.
        if (this.frozen || !this.byConn.delete(key) || this.byConn.size === 0) { return; }
        this.host.setVisible(this.union())
          .catch((err: unknown) => console.error('[marcode] daemon: set-visible failed', err));
      },
    };
  }

  private async set(key: object, ids: SessionId[]): Promise<SessionId[]> {
    const mine = new Set(this.byConn.get(key) ?? []);
    const shown = new Set(this.host.visibleIds());
    this.byConn.set(key, [...ids]);
    await this.host.setVisible(this.union());
    return ids.filter((id) => !mine.has(id) && shown.has(id));
  }

  private union(): SessionId[] {
    const all = new Set<SessionId>();
    for (const ids of this.byConn.values()) { for (const id of ids) { all.add(id); } }
    return [...all];
  }
}
