import { resolve } from 'node:path';
import { samePath } from '../git-worktree';
import type { McpPendingChange } from '../../protocol/messages';

interface Entry extends McpPendingChange { key: string; at: number }

/**
 * Config-file edits made from `/mcp`, keyed by file, so every live session that
 * loads that file — not just the one that edited it — knows it is stale.
 */
export class McpChangeLog {
  private entries: Entry[] = [];

  record(key: string, name: string, origin: McpPendingChange['origin'], change: McpPendingChange['change'], at = Date.now()): void {
    const k = normalizeKey(key);
    const prior = this.entries.find((e) => sameKey(e.key, k) && e.name === name);
    this.entries = this.entries.filter((e) => e !== prior);
    if (prior?.change === 'added' && change === 'removed') { return; }
    this.entries.push({ key: k, name, origin, change, at });
  }

  /** Changes to any of `keys` made after the session's backend read its config. */
  pendingFor(keys: string[], loadedAt: number | undefined): McpPendingChange[] {
    if (loadedAt === undefined) { return []; }
    const wanted = keys.map(normalizeKey);
    return this.entries
      .filter((e) => e.at > loadedAt && wanted.some((k) => sameKey(e.key, k)))
      .map(({ name, origin, change }) => ({ name, origin, change }));
  }
}

/** `path` or `path#repoRoot` (a per-repo block inside a shared file). */
function normalizeKey(key: string): string {
  const [file, scope] = key.split('#');
  return scope === undefined ? resolve(file) : `${resolve(file)}#${resolve(scope)}`;
}

function sameKey(a: string, b: string): boolean {
  return samePath(a, b);
}
