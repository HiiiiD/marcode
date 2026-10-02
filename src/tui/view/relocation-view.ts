import { folderName } from '../../client-core/folder-name';
import type { SessionId, TranscriptItem, WebviewToHost } from '../../protocol/messages';

export type RelocationItem = Extract<TranscriptItem, { role: 'relocation' }>;
export interface RelocationCard { id: string; name: string; path: string; state: RelocationItem['state'] }

/** Keys address one offer at a time: the newest still-open one. An older open offer is shown but not answerable. */
export function activeRelocation(items: TranscriptItem[]): RelocationItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.role === 'relocation' && (it.state === 'pending' || it.state === 'queued')) { return it; }
  }
  return undefined;
}

export function relocationCard(item: RelocationItem): RelocationCard {
  return { id: item.id, name: item.path === '' ? 'worktree' : folderName(item.path), path: item.path, state: item.state };
}

export function relocationMessage(sessionId: SessionId, item: RelocationItem, key: 'move' | 'stay'): WebviewToHost | undefined {
  if (item.state === 'pending') { return { t: 'answer-relocation', id: sessionId, itemId: item.id, move: key === 'move' }; }
  // A queued move was already answered "move"; the only thing left to say is "never mind".
  if (item.state === 'queued' && key === 'stay') { return { t: 'cancel-relocation', id: sessionId, itemId: item.id }; }
  return undefined;
}
