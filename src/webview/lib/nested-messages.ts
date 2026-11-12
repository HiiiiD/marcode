import { DETACHED_PREFIX } from '../../shared/subagent-markers';
import type { NestedMessage } from '../components/nested-messages-context';
import type { TranscriptItem } from '../../protocol/messages';

/**
 * Splits off the turns a hosted worker sent its parent, so the main chat does not
 * carry them: they are shown on the worker's own card instead. A worker promoted
 * to its own session is a peer again and keeps its messages in the chat.
 */
export function splitNestedMessages(items: TranscriptItem[]): {
  main: TranscriptItem[];
  byChild: Map<string, NestedMessage[]>;
} {
  const nested = new Set<string>();
  for (const item of items) {
    if (item.role !== 'tool' || item.tool.kind !== 'subagent' || !item.tool.childSessionId) { continue; }
    const detached = item.output?.kind === 'text' && item.output.text.startsWith(DETACHED_PREFIX);
    if (!detached) { nested.add(item.tool.childSessionId); }
  }
  const byChild = new Map<string, NestedMessage[]>();
  if (nested.size === 0) { return { main: items, byChild }; }
  const main = items.filter((item) => {
    if (item.role !== 'user' || !item.from || !nested.has(item.from.sessionId)) { return true; }
    byChild.set(item.from.sessionId, [...(byChild.get(item.from.sessionId) ?? []), item]);
    return false;
  });
  return { main, byChild };
}
