import type { SessionState } from '../protocol/messages';

export function isHidden(s: { kind?: SessionState['kind'] }): boolean {
  return s.kind === 'subagent' || s.kind === 'side';
}
