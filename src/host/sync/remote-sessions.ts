import * as path from 'node:path';
import type { SessionId, SessionState, TranscriptPatch } from '../../protocol/messages';
import { ForeignTail } from '../foreign-tail';
import { TranscriptStore } from '../transcript-store';
import { mirrorStoreDir, readRemoteRoster } from './remote-roster';

export interface RemoteSessionsDeps {
  root: string;
  windowProjects: () => Promise<Set<string>>;
  tailIntervalMs?: number;
}

/** Other devices' sessions of this window's projects, as roster rows over the machine-wide mirror. */
export class RemoteSessions {
  private readonly stores = new Map<string, TranscriptStore>();

  constructor(private readonly deps: RemoteSessionsDeps) {}

  /** Rows to adopt, update or drop; an id this host already holds as a local session is never touched. */
  async sync(meta: Map<SessionId, SessionState>): Promise<{ adopt: SessionState[]; update: SessionState[]; drop: SessionId[] }> {
    const [{ rows, devices }, projects] = await Promise.all([readRemoteRoster(this.deps.root), this.deps.windowProjects()]);
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
    const drop = [...meta.values()].filter((s) => s.remote && !seen.has(s.id)).map((s) => s.id);
    return { adopt, update, drop };
  }

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
