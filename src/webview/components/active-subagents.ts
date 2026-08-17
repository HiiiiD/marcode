// Pure helper for the header's active-subagent badge, kept free of React and
// UI imports so the mocha unit harness can require it directly — the same
// split subagent-window.ts and status.ts use.
import { subagentLabel } from './subagent-window';
import type { TranscriptItem } from '../../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

export interface ActiveSubagent {
  /**
   * The item to scroll to — always a TOP-LEVEL transcript item, because those
   * are the only ones `transcript.tsx` registers as `MessageScrollerItem`s. A
   * subagent running inside another subagent is reached by scrolling to the
   * outer card that contains it.
   */
  itemId: string;
  /** What is running: the agent type when the call names one, else its label. */
  agent: string;
  /** When that subagent started, for elapsed. Not the container's start. */
  ts: number;
}

/**
 * Every subagent still running, oldest first, one entry per scroll target.
 *
 * Derived from the loaded transcript rather than transmitted: a `running`
 * count on `SessionState` would be one more thing to drift from the items it
 * counts, and the pane already holds every item this reads.
 *
 * A container is active when it is a running subagent OR holds a running
 * subagent child — so a Task that has returned while the agent it spawned has
 * not still points at work in progress. Deduped by container: two running
 * subagents in one card are one place to look, and counting them twice would
 * promise the user two destinations that are the same destination.
 */
export function activeSubagents(items: TranscriptItem[]): ActiveSubagent[] {
  const found: ActiveSubagent[] = [];

  for (const item of items) {
    if (item.role !== 'tool') { continue; }
    // Depth-1 children only, which is all `TranscriptItem.children` ever
    // carries — the host flattens grandchildren onto their nearest ancestor.
    const running = [item, ...(item.children ?? [])].filter(isRunningSubagent);
    if (running.length === 0) { continue; }

    // The oldest of them names the card: it is the one that has been waiting
    // longest, which is what the elapsed reading is worth quoting for.
    const oldest = running.reduce((a, b) => (b.ts < a.ts ? b : a));
    found.push({ itemId: item.id, agent: subagentLabel(oldest), ts: oldest.ts });
  }

  return found.sort((a, b) => a.ts - b.ts);
}

function isRunningSubagent(item: TranscriptItem): item is ToolItem {
  return item.role === 'tool' && item.state === 'running' && item.tool.kind === 'subagent';
}
