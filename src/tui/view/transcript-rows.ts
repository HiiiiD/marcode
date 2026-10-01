import { describeTool, type ToolHeader } from '../../client-core/tool-render';
import type { TranscriptItem } from '../../protocol/messages';

export type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

export type TranscriptRow =
  | { kind: 'user'; id: string; text: string; fromName?: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'tool'; id: string; item: ToolItem; header: ToolHeader; state: 'running' | 'ok' | 'error' }
  | { kind: 'permission'; id: string; header: ToolHeader; state: 'pending' | 'allowed' | 'denied'; reason?: string }
  | { kind: 'question'; id: string; state: string; text: string }
  | { kind: 'notice'; id: string; tone: 'error' | 'info'; text: string };

export function transcriptRows(items: TranscriptItem[], running: boolean): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const item of items) {
    switch (item.role) {
      case 'user':
        rows.push({ kind: 'user', id: item.id, text: item.text, ...(item.from ? { fromName: item.from.name } : {}) });
        break;
      case 'assistant':
        if (item.text !== '') { rows.push({ kind: 'assistant', id: item.id, text: item.text, streaming: false }); }
        break;
      case 'tool':
        rows.push({ kind: 'tool', id: item.id, item, header: describeTool(item.tool), state: item.state });
        break;
      case 'permission':
        rows.push({ kind: 'permission', id: item.id, header: describeTool(item.tool), state: item.state, ...(item.reason ? { reason: item.reason } : {}) });
        break;
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
        rows.push({ kind: 'notice', id: item.id, tone: item.state === 'failed' ? 'error' : 'info', text: `Conversation compaction ${item.state}` });
        break;
      case 'relocation':
        rows.push({ kind: 'notice', id: item.id, tone: 'info', text: `Worktree move offered: ${item.path} (${item.state})` });
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
