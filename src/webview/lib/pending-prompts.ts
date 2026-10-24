import type { PaneState } from '../../client-core/reducer';
import type { TranscriptItem } from '../../protocol/messages';

type PromptItem = Extract<TranscriptItem, { role: 'permission' | 'question' }>;
type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

export function isLivePrompt(item: TranscriptItem, pane: PaneState): item is PromptItem {
  if (item.role !== 'permission' && item.role !== 'question') { return false; }
  const pending = item.role === 'permission' ? pane.pending : pane.pendingQuestions;
  return item.state === 'pending' && pending.some((request) => request.requestId === item.requestId);
}

export function pendingPrompts(pane: PaneState): { item: PromptItem; parent?: ToolItem }[] {
  const entries: { item: PromptItem; parent?: ToolItem }[] = [];
  const visit = (items: TranscriptItem[], parent?: ToolItem) => {
    for (const item of items) {
      if (isLivePrompt(item, pane)) { entries.push({ item, parent }); }
      if (item.role === 'tool' && item.children) { visit(item.children, item); }
    }
  };
  visit(pane.items);
  return entries.sort((a, b) => a.item.ts - b.item.ts);
}
