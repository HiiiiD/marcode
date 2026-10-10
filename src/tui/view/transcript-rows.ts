import { compactionHeadline } from '../../client-core/compaction';
import { shellCard, type ShellCardModel } from '../../client-core/shell-card';
import { describeTool, type ToolHeader } from '../../client-core/tool-render';
import { activeRelocation, relocationCard, type RelocationCard } from './relocation-view';
import type { Attachment, TranscriptItem } from '../../protocol/messages';

export type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

export interface FoldedPermission { state: 'pending' | 'allowed' | 'denied'; reason?: string }

export type TranscriptRow =
  | { kind: 'user'; id: string; text: string; fromName?: string; attachments?: Attachment[] }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'tool'; id: string; item: ToolItem; header: ToolHeader; state: 'running' | 'ok' | 'error'; permission?: FoldedPermission }
  | { kind: 'permission'; id: string; header: ToolHeader; state: 'pending' | 'allowed' | 'denied'; reason?: string }
  | { kind: 'question'; id: string; state: string; text: string }
  | { kind: 'relocation'; id: string; card: RelocationCard; active: boolean }
  | { kind: 'compaction'; id: string; state: 'running' | 'done' | 'failed'; headline: string; summary?: string; error?: string }
  | { kind: 'shell'; id: string; card: ShellCardModel }
  | { kind: 'notice'; id: string; tone: 'error' | 'info'; text: string };

export function transcriptRows(items: TranscriptItem[], running: boolean): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const activeId = activeRelocation(items)?.id;
  for (const item of items) {
    switch (item.role) {
      case 'user':
        rows.push({ kind: 'user', id: item.id, text: item.text, ...(item.from ? { fromName: item.from.name } : {}), ...(item.attachments?.length ? { attachments: item.attachments } : {}) });
        break;
      case 'assistant':
        if (item.text !== '') { rows.push({ kind: 'assistant', id: item.id, text: item.text, streaming: false }); }
        break;
      case 'tool':
        rows.push({ kind: 'tool', id: item.id, item, header: describeTool(item.tool), state: item.state });
        break;
      case 'permission': {
        // The host appends the tool before its permission request; showing them as two rows reads backwards.
        let owner: Extract<TranscriptRow, { kind: 'tool' }> | undefined;
        for (let i = rows.length - 1; i >= 0 && !owner; i--) {
          const r = rows[i];
          if (r.kind === 'tool' && r.item.toolId === item.requestId) { owner = r; }
        }
        if (owner) {
          owner.permission = { state: item.state, ...(item.reason ? { reason: item.reason } : {}) };
          break;
        }
        rows.push({ kind: 'permission', id: item.id, header: describeTool(item.tool), state: item.state, ...(item.reason ? { reason: item.reason } : {}) });
        break;
      }
      case 'question':
        rows.push({ kind: 'question', id: item.id, state: item.state, text: item.questions.map((q) => q.question).join(' / ') });
        break;
      case 'error':
        rows.push({ kind: 'notice', id: item.id, tone: 'error', text: item.message });
        break;
      case 'switch':
        rows.push({ kind: 'notice', id: item.id, tone: 'info', text: item.text });
        break;
      case 'compaction':
        rows.push({
          kind: 'compaction', id: item.id, state: item.state, headline: compactionHeadline(item),
          ...(item.state === 'done' && item.summary ? { summary: item.summary } : {}),
          ...(item.error ? { error: item.error } : {}),
        });
        break;
      case 'relocation':
        rows.push({ kind: 'relocation', id: item.id, card: relocationCard(item), active: item.id === activeId });
        break;
      case 'shell':
        rows.push({ kind: 'shell', id: item.id, card: shellCard(item) });
        break;
      default: {
        const unhandled: never = item;
        return unhandled;
      }
    }
  }
  if (running) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.kind === 'assistant') { rows[i] = { ...row, streaming: true }; break; }
    }
  }
  return rows;
}
