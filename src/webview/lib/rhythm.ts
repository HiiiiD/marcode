import type { TranscriptItem } from '../../protocol/messages';

export type Beat = 'user' | 'prose' | 'machine' | 'card';

/** What an item is to the eye: the answer, the machinery around it, a decision that needs the user, or the user's own turn. */
export function beatOf(item: TranscriptItem | undefined): Beat | undefined {
  if (!item) { return undefined; }
  switch (item.role) {
    case 'user': return 'user';
    case 'assistant': return 'prose';
    case 'tool': case 'shell': case 'compaction': case 'switch': return 'machine';
    default: return 'card';
  }
}

/**
 * The gap above an item, decided by what it follows, so the whole transcript
 * shares one rhythm: machinery packs into tight runs, prose is set off from a
 * run by the same 16px on both sides, and the user's turn gets the most room.
 */
export function gapAbove(prev: Beat | undefined, next: Beat): string {
  if (prev === undefined) { return ''; }
  if (next === 'user') { return 'mt-6'; }
  if (next === 'machine') { return prev === 'machine' ? 'mt-0.5' : prev === 'prose' ? 'mt-4' : 'mt-3'; }
  if (next === 'prose') { return prev === 'prose' ? 'mt-3' : prev === 'user' ? 'mt-3' : 'mt-4'; }
  return 'mt-3';
}
