import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { OwnerRecord } from '../../sync/api-types';
import type { MovePayload } from '../../sync/move-records';
import type { SessionPayload } from '../../sync/session-records';
import { writeFileAtomic } from '../atomic-file';
import { TranscriptStore } from '../transcript-store';
import {
  attachmentDir, chunkFileName, DEVICES_FILE, type DevicePresence, INBOX_DIR, type MirrorEntry, mirrorStoreDir, OWNERS_FILE,
  readEntries, readJson, SESSIONS_FILE, threadDir,
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
  private flushing: Promise<void> = Promise.resolve();

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

  /** Thread and attachment chunks land as one file each (idempotent, any order); move messages go to the inbox. */
  async applyMove(deviceId: string, payload: MovePayload): Promise<void> {
    if (payload.type === 'move-request' || payload.type === 'move-reply') {
      const dir = path.join(this.root, INBOX_DIR);
      await fs.mkdir(dir, { recursive: true });
      const kind = payload.type === 'move-request' ? 'request' : 'reply';
      await writeFileAtomic(path.join(dir, `${encodeURIComponent(payload.requestId)}.${kind}.json`), JSON.stringify({ from: deviceId, payload }));
      return;
    }
    const base = payload.type === 'thread-chunk'
      ? path.join(threadDir(this.root, deviceId, payload.sessionId), encodeURIComponent(payload.name))
      : path.join(attachmentDir(this.root, deviceId, payload.sessionId), encodeURIComponent(payload.attachmentId));
    const dir = path.join(base, String(payload.generation));
    await fs.mkdir(dir, { recursive: true });
    await writeFileAtomic(path.join(dir, chunkFileName(payload.offset, payload.total)), Buffer.from(payload.data, 'base64'));
    if (payload.type === 'attachment') {
      await writeFileAtomic(path.join(base, 'meta.json'), JSON.stringify({ name: payload.name, mime: payload.mime }));
    }
    // Older generations are superseded: the file was rewritten from the start.
    for (const entry of await fs.readdir(base).catch(() => [] as string[])) {
      const generation = Number(entry);
      if (Number.isSafeInteger(generation) && generation < payload.generation) { await fs.rm(path.join(base, entry), { recursive: true, force: true }); }
    }
  }

  private owners: OwnerRecord[] | undefined;

  async setOwners(owners: OwnerRecord[]): Promise<void> {
    this.owners = owners;
    this.devicesDirty = true;
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

  /**
   * Forgets everything cached: another host may have held the lease and written the mirror since.
   * Call whenever the lease is (re)gained, before the first apply.
   */
  reset(): void {
    this.stores.clear();
    this.entries.clear();
    this.dirty.clear();
    this.devices = undefined;
    this.devicesDirty = this.newer.size > 0;
  }

  /** Serialized: a flush that overlapped another could clear a device's dirty mark its own write never covered. */
  flush(): Promise<void> {
    const run = this.flushing.then(() => this.flushOnce());
    this.flushing = run.catch(() => undefined);
    return run;
  }

  private async flushOnce(): Promise<void> {
    await Promise.all([...this.stores.values()].map((s) => s.flush()));
    // Taken before the writes: an apply landing during them marks its device dirty again for the next flush.
    const devices = [...this.dirty];
    this.dirty.clear();
    try {
      for (const deviceId of devices) {
        const dir = mirrorStoreDir(this.root, deviceId);
        await fs.mkdir(dir, { recursive: true });
        await writeFileAtomic(path.join(dir, SESSIONS_FILE), JSON.stringify({ entries: this.entries.get(deviceId) ?? {} }));
      }
    } catch (err) {
      for (const deviceId of devices) { this.dirty.add(deviceId); }
      throw err;
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
      if (this.owners) { await writeFileAtomic(path.join(this.root, OWNERS_FILE), JSON.stringify(this.owners)); }
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
    if (!entries) {
      entries = await readEntries(this.root, deviceId);
      // Starting over from nothing would overwrite every row on the next flush; failing retries the record instead.
      if (!entries) { throw new Error(`mirror: cannot read ${deviceId}'s sessions`); }
      this.entries.set(deviceId, entries);
    }
    return entries;
  }
}
