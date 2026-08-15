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
