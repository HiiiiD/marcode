import { resolve } from 'node:path';
import { samePath } from '../git-worktree';
import type { McpPendingChange } from '../../protocol/messages';

/** A config file, or one per-repo block inside a shared file (`scope` is that repo's root). */
export interface McpChangeKey { file: string; scope?: string }

interface Entry extends McpPendingChange { key: McpChangeKey; at: number }

/**
 * Config-file edits made from `/mcp`, keyed by file, so every live session that
 * loads that file — not just the one that edited it — knows it is stale.
 */
export class McpChangeLog {
  private entries: Entry[] = [];

  record(key: McpChangeKey, name: string, origin: McpPendingChange['origin'], change: McpPendingChange['change'], at = Date.now()): void {
    const k = normalizeKey(key);
    const prior = this.entries.find((e) => sameKey(e.key, k) && e.name === name);
    this.entries = this.entries.filter((e) => e !== prior);
    if (prior?.change === 'added' && change === 'removed') { return; }
    this.entries.push({ key: k, name, origin, change, at });
  }

  /** Changes to any of `keys` made after the session's backend read its config. */
  pendingFor(keys: McpChangeKey[], loadedAt: number | undefined): McpPendingChange[] {
    if (loadedAt === undefined) { return []; }
    const wanted = keys.map(normalizeKey);
    return this.entries
      .filter((e) => e.at > loadedAt && wanted.some((k) => sameKey(e.key, k)))
      .map(({ name, origin, change }) => ({ name, origin, change }));
  }
}

function normalizeKey(key: McpChangeKey): McpChangeKey {
  return key.scope === undefined ? { file: resolve(key.file) } : { file: resolve(key.file), scope: resolve(key.scope) };
}

function sameKey(a: McpChangeKey, b: McpChangeKey): boolean {
  if ((a.scope === undefined) !== (b.scope === undefined)) { return false; }
  return samePath(a.file, b.file) && (a.scope === undefined || samePath(a.scope, b.scope!));
}
