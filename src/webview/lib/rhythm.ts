import type { TranscriptItem } from '../../protocol/messages';

export type Beat = 'user' | 'prose' | 'machine' | 'card';

/** What an item is to the eye: the answer, the machinery around it, a decision that needs the user, or the user's own turn. */
export function beatOf(item: TranscriptItem | undefined, edge: 'first' | 'last' = 'first'): Beat | undefined {
  if (!item) { return undefined; }
  switch (item.role) {
    case 'user': return 'user';
    // An assistant item can open with its reasoning row, which looks and packs like any other machinery; only its text is prose.
    case 'assistant': {
      const hasText = item.text.trim() !== '';
      if (edge === 'first') { return item.thinking ? 'machine' : 'prose'; }
      return hasText || !item.thinking ? 'prose' : 'machine';
    }
    case 'tool': case 'shell': case 'compaction': case 'switch': return 'machine';
    default: return 'card';
  }
}

/**
 * The gap above an item, decided by what it follows, so the whole transcript
 * shares one rhythm: machinery packs into tight runs, prose is set off from a
 * run by a small, equal gap on both sides (the rows carry their own padding), and the user's turn gets the most room.
 */
export function gapAbove(prev: Beat | undefined, next: Beat): string {
  if (prev === undefined) { return ''; }
  if (next === 'user') { return 'mt-6'; }
  if (next === 'machine') { return prev === 'machine' ? 'mt-0.5' : prev === 'prose' ? 'mt-1.5' : 'mt-3'; }
  if (next === 'prose') { return prev === 'prose' ? 'mt-3' : prev === 'user' ? 'mt-3' : 'mt-2'; }
  return 'mt-3';
}
