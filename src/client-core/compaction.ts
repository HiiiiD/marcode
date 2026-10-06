import type { TranscriptItem } from '../protocol/messages';

export type CompactionItem = Extract<TranscriptItem, { role: 'compaction' }>;

export function compactionHeadline(item: CompactionItem): string {
  if (item.state === 'running') { return 'Compacting conversation…'; }
  if (item.state === 'failed') { return 'Compaction failed'; }
  return item.trigger === 'auto' ? 'Conversation compacted automatically' : 'Conversation compacted';
}
