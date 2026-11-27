import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionPayload } from '../../sync/session-records';
import { writeFileAtomic } from '../atomic-file';
import { TranscriptStore } from '../transcript-store';
import {
  DEVICES_FILE, type DevicePresence, type MirrorEntry, mirrorStoreDir, readEntries, readJson, SESSIONS_FILE,
} from './remote-roster';

export { mirrorStoreDir } from './remote-roster';

/**
 * The machine-wide copy of other devices' sessions, written only by the sync engine's lease holder.
 * Each device's directory is a `TranscriptStore` root, so readers tail it like a foreign session's JSONL.
 * Every apply is idempotent: a page replayed after a crash changes nothing.
 */
export class SessionMirror {
  private readonly stores = new Map<string, TranscriptStore>();
  private readonly entries = new Map<string, Record<string, MirrorEntry>>();
  private readonly dirty = new Set<string>();
  private devices: DevicePresence[] | undefined;
  private devicesDirty = false;
  private readonly newer = new Set<string>();

  constructor(private readonly root: string) {}

  async apply(deviceId: string, payload: SessionPayload): Promise<void> {
    const entries = await this.entriesOf(deviceId);
    const id = payload.sessionId;
    if (payload.type === 'session-delete') {
      delete entries[id];
      await this.store(deviceId).remove(id);
    } else if (payload.type === 'session-meta') {
      const { rev = 0, gap } = entries[id] ?? {};
      entries[id] = {
        state: payload.state, projectId: payload.projectId, relCwd: payload.relCwd, rev,
        ...(payload.branch ? { branch: payload.branch } : {}), ...(gap ? { gap } : {}),
      };
    } else {
      const store = this.store(deviceId);
      for (const { item } of payload.ops) {
        // By what is there, not by `op`: a replayed append is a replace, and a replace of an item never seen is an append.
        if (await store.find(id, item.id)) { store.replace(id, item); } else { store.append(id, item); }
      }
      const entry = entries[id] ?? { rev: 0 };
      if (payload.rev > entry.rev + 1) { entry.gap = true; }
      entry.rev = Math.max(entry.rev, payload.rev);
      entries[id] = entry;
    }
    this.dirty.add(deviceId);
  }

  markNewerFormat(deviceId: string): void {
    this.newer.add(deviceId);
    this.devicesDirty = true;
  }

  async setDevices(devices: Array<Omit<DevicePresence, 'newerFormat'>>): Promise<void> {
    const prior = this.devices ?? await readJson<DevicePresence[]>(path.join(this.root, DEVICES_FILE)) ?? [];
    const newer = new Set(prior.filter((d) => d.newerFormat).map((d) => d.deviceId));
    this.devices = devices.map((d) => (newer.has(d.deviceId) ? { ...d, newerFormat: true as const } : { ...d }));
    this.devicesDirty = true;
  }

  async flush(): Promise<void> {
    await Promise.all([...this.stores.values()].map((s) => s.flush()));
    for (const deviceId of [...this.dirty]) {
      const dir = mirrorStoreDir(this.root, deviceId);
      await fs.mkdir(dir, { recursive: true });
      await writeFileAtomic(path.join(dir, SESSIONS_FILE), JSON.stringify({ entries: this.entries.get(deviceId) ?? {} }));
      this.dirty.delete(deviceId);
    }
    if (this.devicesDirty) {
      const list = this.devices ?? await readJson<DevicePresence[]>(path.join(this.root, DEVICES_FILE)) ?? [];
      for (const deviceId of this.newer) {
        const known = list.find((d) => d.deviceId === deviceId);
        if (known) { known.newerFormat = true; } else { list.push({ deviceId, name: deviceId, online: false, lastSeenAt: 0, newerFormat: true }); }
      }
      this.devices = list;
      await fs.mkdir(this.root, { recursive: true });
      await writeFileAtomic(path.join(this.root, DEVICES_FILE), JSON.stringify(list));
      this.devicesDirty = false;
    }
  }

  private store(deviceId: string): TranscriptStore {
    let store = this.stores.get(deviceId);
    if (!store) { store = new TranscriptStore(mirrorStoreDir(this.root, deviceId)); this.stores.set(deviceId, store); }
    return store;
  }

  private async entriesOf(deviceId: string): Promise<Record<string, MirrorEntry>> {
    let entries = this.entries.get(deviceId);
    if (!entries) { entries = await readEntries(this.root, deviceId); this.entries.set(deviceId, entries); }
    return entries;
  }
}
