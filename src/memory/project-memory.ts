import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import type { SessionId } from '../protocol/messages';
import type { SessionDigest } from './digest';
import { FETCH_WINDOW, type FtsMemoryStore } from './fts/fts-memory-store';
import { FtsMemoryReader, type SiblingReader } from './fts/fts-memory-reader';
import { readJsonlTranscript } from './jsonl-transcript';
import type { DigestMeta, MemoryDetail, MemoryHit, MemoryStore, SearchOpts, SessionRecord } from './types';

interface Options {
  refreshMs?: number;
  openReader?: (dbPath: string) => SiblingReader;
}

/**
 * Recall over this workspace's store plus every sibling workspace's `memory.sqlite`, so all
 * checkouts of one project share memory. Writes only ever reach `local`: each sibling file has its
 * own host as its only writer.
 */
export class ProjectMemory implements MemoryStore {
  private readonly siblings = new Map<string, SiblingReader>();
  private listedAt = Number.NEGATIVE_INFINITY;
  private readonly refreshMs: number;
  private readonly openReader: (dbPath: string) => SiblingReader;

  constructor(private readonly local: FtsMemoryStore, private readonly workspaceDir: string, opts: Options = {}) {
    this.refreshMs = opts.refreshMs ?? 30_000;
    this.openReader = opts.openReader ?? ((dbPath) => new FtsMemoryReader(dbPath));
  }

  index(record: SessionRecord): Promise<void> { return this.local.index(record); }
  forget(sessionId: SessionId): Promise<void> { return this.local.forget(sessionId); }
  digestMeta(): Promise<Map<SessionId, DigestMeta>> { return this.local.digestMeta(); }
  setProject(sessionId: SessionId, projectId: string): Promise<void> { return this.local.setProject(sessionId, projectId); }

  async search(query: string, opts: SearchOpts = {}): Promise<MemoryHit[]> {
    const own = await this.local.search(query, opts);
    if (opts.projectId === undefined) { return own; }
    const scope: SearchOpts = { providerId: opts.providerId, limit: opts.limit, match: opts.match, projectId: opts.projectId };
    const seen = new Set(own.map((h) => h.sessionId));
    const merged = [...own];
    for (const [, reader] of this.readers()) {
      for (const hit of this.safely(() => reader.search(query, scope), [])) {
        if (!seen.has(hit.sessionId)) { seen.add(hit.sessionId); merged.push(hit); }
      }
    }
    // bm25 scores from separate databases are not strictly comparable (a small index ranks high); accepted.
    return merged.sort((x, y) => y.score - x.score).slice(0, opts.limit ?? 20);
  }

  async getDigest(sessionId: SessionId): Promise<SessionDigest | undefined> {
    const own = await this.local.getDigest(sessionId);
    if (own) { return own; }
    for (const [, reader] of this.readers()) {
      const digest = this.safely(() => reader.getDigest(sessionId), undefined);
      if (digest) { return digest; }
    }
    return undefined;
  }

  async fetch(hit: { sessionId: SessionId; itemId: string }): Promise<MemoryDetail> {
    const own = await this.local.fetch(hit);
    if (own.items.length > 0) { return own; }
    for (const [dir, reader] of this.readers()) {
      if (!this.safely(() => reader.getDigest(hit.sessionId), undefined)) { continue; }
      const items = await readJsonlTranscript(path.join(dir, 'sessions', `${hit.sessionId}.jsonl`));
      const at = items.findIndex((i) => i.id === hit.itemId);
      if (at >= 0) { return { sessionId: hit.sessionId, items: items.slice(at, at + FETCH_WINDOW) }; }
    }
    return own;
  }

  close(): void {
    for (const reader of this.siblings.values()) { reader.close(); }
    this.siblings.clear();
    this.local.close();
  }

  private safely<T>(read: () => T, fallback: T): T {
    try { return read(); } catch { return fallback; }
  }

  private readers(): Map<string, SiblingReader> {
    const now = Date.now();
    if (now - this.listedAt < this.refreshMs) { return this.siblings; }
    this.listedAt = now;
    const parent = path.dirname(this.workspaceDir);
    const own = path.resolve(this.workspaceDir);
    let names: string[] = [];
    try { names = readdirSync(parent); } catch { names = []; }
    const current = new Set<string>();
    for (const name of names) {
      const dir = path.join(parent, name);
      if (path.resolve(dir) === own) { continue; }
      const dbPath = path.join(dir, 'memory.sqlite');
      if (!existsSync(dbPath)) { continue; }
      current.add(dir);
      const existing = this.siblings.get(dir);
      if (existing?.usable) { continue; }
      existing?.close();
      this.siblings.set(dir, this.safely(() => this.openReader(dbPath), unusable));
    }
    for (const [dir, reader] of this.siblings) {
      if (!current.has(dir)) { reader.close(); this.siblings.delete(dir); }
    }
    return this.siblings;
  }
}

const unusable: SiblingReader = {
  usable: false,
  search: () => [],
  getDigest: () => undefined,
  close: () => {},
};
