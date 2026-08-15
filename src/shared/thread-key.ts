// Which provider thread a session's resume token belongs to.
//
// Directory-keyed history is a Claude fact, not a universal one: the CLI
// stores conversations under ~/.claude/projects/<slugified-cwd>, so a token
// does not resolve from another directory. Codex multiplexes threads by
// threadId with cwd as a per-thread start parameter. The provider declares
// which it is; the host never assumes.

import type { ThreadScope } from '../providers/types';

export function threadKey(providerId: string, scope: ThreadScope, cwd: string): string {
  return scope === 'global' ? providerId : `${providerId}:${cwd}`;
}

/**
 * The directory a thread key qualifies, or `undefined` when it qualifies none.
 *
 * The inverse of `threadKey` under `'cwd'` scope, and the reason it is a
 * function rather than a `split(':')` at each call site: under `'global'`
 * scope the key is a bare provider id, which is *not* a path. A sweep that
 * split on the colon would read `codex` as a directory and offer to delete
 * it, and on Windows it would read `codex:C:\repo` as `C` besides. Matching
 * against the provider ids this install actually has settles both — the
 * separator is the first colon *after a known id*, and everything past it is
 * the path verbatim.
 */
export function threadKeyCwd(key: string, providerIds: Iterable<string>): string | undefined {
  for (const id of providerIds) {
    if (key.startsWith(`${id}:`)) { return key.slice(id.length + 1); }
  }
  return undefined;
}
