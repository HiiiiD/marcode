import type { TranscriptItem } from '../../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

export type TranscriptEntry =
  | { kind: 'item'; item: TranscriptItem }
  | { kind: 'group'; id: string; items: ToolItem[] };

const groupOf = (item: TranscriptItem): string | undefined =>
  item.role === 'tool' && item.tool.kind === 'subagent' ? item.tool.groupId : undefined;

/** Folds consecutive hosted workers of one `spawn_collaborators` call into a single entry. */
export function groupSubagents(items: TranscriptItem[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const item of items) {
    const gid = groupOf(item);
    const prev = out[out.length - 1];
    if (gid && item.role === 'tool' && prev?.kind === 'group' && groupOf(prev.items[0]) === gid) {
      prev.items.push(item);
    } else if (gid && item.role === 'tool') {
      out.push({ kind: 'group', id: item.id, items: [item] });
    } else {
      out.push({ kind: 'item', item });
    }
  }
  return out.map((e) => (e.kind === 'group' && e.items.length === 1 ? { kind: 'item', item: e.items[0] } : e));
}
