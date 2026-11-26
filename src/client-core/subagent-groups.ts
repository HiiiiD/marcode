import { describeTool } from './tool-render';
import type { TranscriptItem } from '../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

export type TranscriptEntry =
  | { kind: 'item'; item: TranscriptItem; /** Identical consecutive calls folded into this row. */ more?: ToolItem[] }
  | { kind: 'group'; id: string; items: ToolItem[] };

/** The `spawn_collaborators` call a hosted worker belongs to. */
export const groupOf = (item: TranscriptItem): string | undefined =>
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

const isPlainTool = (item: TranscriptItem): item is ToolItem =>
  item.role === 'tool' && !(item.tool.kind === 'subagent' && item.tool.action !== 'message') && !(item.children && item.children.length > 0);

const runKey = (item: ToolItem) => {
  const { verb, primary } = describeTool(item.tool);
  return `${item.tool.kind}\u0000${verb}\u0000${primary}`;
};

/**
 * Folds consecutive identical tool calls (three edits to one file, five reads of one path) into a single entry, so a
 * run of repetition reads as one line with a count instead of a stack of identical rows.
 */
export function mergeToolRuns(entries: TranscriptEntry[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const entry of entries) {
    const prev = out[out.length - 1];
    if (
      entry.kind === 'item' && isPlainTool(entry.item) && prev?.kind === 'item' && isPlainTool(prev.item)
      && runKey(prev.item) === runKey(entry.item)
    ) {
      prev.more = [...(prev.more ?? []), entry.item];
    } else {
      out.push(entry.kind === 'item' ? { ...entry } : entry);
    }
  }
  return out;
}
