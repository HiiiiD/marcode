import * as path from 'node:path';
import type { SessionId, SessionState, TranscriptPatch } from '../../protocol/messages';
import { ForeignTail } from '../foreign-tail';
import { TranscriptStore } from '../transcript-store';
import type { SyncState } from '../../sync/sync-state';
import { mirrorStoreDir, readOwners, readRemoteRoster, type RemoteRow } from './remote-roster';

export interface RemoteSessionsDeps {
  root: string;
  windowProjects: () => Promise<Set<string>>;
  tailIntervalMs?: number;
  /** Ownership between devices; absent when this device is not paired. */
  owners?: { key: (sessionId: string) => string | undefined; self: { deviceId: string; deviceName: string }; sync: SyncState };
}

/** A local session another device now owns. `fork`: this device holds content the new owner never got. */
export interface Ceded { id: SessionId; fork: boolean }

/** Other devices' sessions of this window's projects, as roster rows over the machine-wide mirror. */
export class RemoteSessions {
  private readonly stores = new Map<string, TranscriptStore>();

  constructor(private readonly deps: RemoteSessionsDeps) {}

  /** Rows to adopt, update or drop; an id this host already holds as a local session is never touched. */
  async sync(meta: Map<SessionId, SessionState>): Promise<{ adopt: SessionState[]; update: SessionState[]; drop: SessionId[]; ceded: Ceded[] }> {
    const [{ rows: all, devices, unreadable }, projects, owners] = await Promise.all([
      readRemoteRoster(this.deps.root), this.deps.windowProjects(), this.deps.owners ? readOwners(this.deps.root) : Promise.resolve(new Map()),
    ]);
    const ownerOf = (id: string) => { const k = this.deps.owners?.key(id); return k ? owners.get(k) : undefined; };
    const rows = this.ownersCopies(all, ownerOf);
    const ceded: Ceded[] = [];
    const self = this.deps.owners?.self.deviceId;
    for (const s of meta.values()) {
      // Another host on this machine leases it: that host gives it up, not this one.
      if (s.remote || s.owner) { continue; }
      const record = ownerOf(s.id);
      if (!record || !self || record.deviceId === self) { continue; }
      const sync = this.deps.owners!.sync;
      // Only a newer claim than ours: a stale owners file must never take back what this device just won.
      if (record.epoch <= sync.heldEpoch(s.id)) { continue; }
      ceded.push({ id: s.id, fork: sync.publishedRev(s.id) > record.baseRev || sync.hasOutboxOps(s.id) });
    }
    // A file that could not be read this time says nothing about that device's sessions: keep them.
    const unsure = (deviceId: string): boolean => unreadable.includes('*') || unreadable.includes(deviceId);
    const byDevice = new Map(devices.map((d) => [d.deviceId, d]));
    const adopt: SessionState[] = [];
    const update: SessionState[] = [];
    const seen = new Set<SessionId>();
    for (const row of rows) {
      if (!projects.has(row.projectId)) { continue; }
      const mine = meta.get(row.state.id);
      if (mine && !mine.remote) { continue; }
      const device = byDevice.get(row.deviceId);
      const online = device?.online === true;
      const next: SessionState = {
        ...row.state,
        // An offline owner runs nothing: its last mirrored "running" is a stale word.
        status: online ? row.state.status : 'idle',
        remote: {
          deviceId: row.deviceId, deviceName: device?.name ?? row.deviceId, online, lastSeenAt: device?.lastSeenAt ?? 0, relCwd: row.relCwd,
          ...(row.branch ? { branch: row.branch } : {}), ...(row.gap ? { gap: true as const } : {}),
          ...(device?.newerFormat ? { newerFormat: true as const } : {}),
        },
      };
      seen.add(next.id);
      if (!mine) { adopt.push(next); } else if (JSON.stringify(mine) !== JSON.stringify({ ...mine, ...next })) { update.push(next); }
    }
    const drop = [...meta.values()].filter((s) => s.remote && !seen.has(s.id) && !unsure(s.remote.deviceId)).map((s) => s.id);
    return { adopt, update, drop, ceded };
  }

  /** One row per session: when two devices' streams both carry it (a move), the owner's copy. */
  private ownersCopies(rows: RemoteRow[], ownerOf: (id: string) => { deviceId: string } | undefined): RemoteRow[] {
    const byId = new Map<string, RemoteRow[]>();
    for (const row of rows) {
      if (row.deviceId === this.deps.owners?.self.deviceId) { continue; }
      byId.set(row.state.id, [...(byId.get(row.state.id) ?? []), row]);
    }
    return [...byId.values()].map((copies) => {
      const owner = ownerOf(copies[0].state.id)?.deviceId;
      return copies.find((c) => c.deviceId === owner) ?? copies.reduce((a, b) => (b.state.updatedAt > a.state.updatedAt ? b : a));
    });
  }

  dropOutbox(id: SessionId): void {
    try { this.deps.owners?.sync.dropSessionOutbox(id); } catch (err) { console.error('[mar-code] sync: could not drop the outbox of', id, err); }
  }

  get selfName(): string | undefined { return this.deps.owners?.self.deviceName; }

  /** A read-only store over one device's mirrored transcripts. */
  store(deviceId: string): TranscriptStore {
    let store = this.stores.get(deviceId);
    if (!store) { store = new TranscriptStore(mirrorStoreDir(this.deps.root, deviceId)); this.stores.set(deviceId, store); }
    return store;
  }

  tail(state: SessionState, onPatch: (patch: TranscriptPatch) => void): ForeignTail {
    const deviceId = state.remote?.deviceId ?? '';
    const store = this.store(deviceId);
    store.markForeign(state.id);
    return new ForeignTail({
      id: state.id, store, file: path.join(store.root, 'sessions', `${state.id}.jsonl`), intervalMs: this.deps.tailIntervalMs,
      // Leaving the roster (a tombstone, a project no longer open) is what ends it, through the roster sync.
      stillForeign: async () => true,
      onPatch, onFree: () => undefined,
    });
  }
}
