import type { SessionState, TranscriptItem } from '../protocol/messages';

/** Whether the person has said anything in a branch since it was forked: only then is it worth keeping. */
export function hasOwnTurns(state: Pick<SessionState, 'forkedItemCount'>, items: TranscriptItem[]): boolean {
  return items.slice(state.forkedItemCount ?? 0).some((i) => i.role === 'user');
}
