// Pure helpers for SubagentCard, kept free of React and UI imports so the
// mocha unit harness can require them directly — the same split
// tool-card-format.ts and status.ts use.
import type { TranscriptItem } from '../../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

/**
 * How many of a subagent's children an expanded card renders.
 *
 * The card is a live activity indicator, not a log reader: ten rows show
 * what the subagent is doing now. Rendering more would imitate a full log
 * view that does not exist, and would make an expanded card taller than the
 * viewport for a subagent that ran hundreds of tools.
 *
 * Because the window is the LAST N, the newest child is always on screen —
 * which is what makes live tailing free, with no scroll container, no
 * follow logic and no scrolled-up detection.
 */
export const SUBAGENT_CHILD_WINDOW = 10;

export function windowChildren(children: TranscriptItem[]): TranscriptItem[] {
  return children.length <= SUBAGENT_CHILD_WINDOW
    ? children
    : children.slice(children.length - SUBAGENT_CHILD_WINDOW);
}

export interface SubagentSummary {
  toolCount: number;
  running: number;
  /** A child is waiting on the user, so the card must force itself open. */
  blocked: boolean;
  elapsedMs: number;
}

/**
 * Everything the collapsed header shows, derived from the children already
 * on the item. Nothing here is transmitted — a `summary` field on the wire
 * would be one more thing to drift from what it summarizes.
 */
export function summarizeSubagent(item: ToolItem, now: number): SubagentSummary {
  const children = item.children ?? [];
  let running = 0;
  let blocked = false;
  let toolCount = 0;
  for (const child of children) {
    if (child.role === 'tool') {
      toolCount++;
      if (child.state === 'running') { running++; }
    } else if (child.role === 'permission' && child.state === 'pending') {
      blocked = true;
    }
  }
  // A settled subagent must stop ticking, and its own item carries no end
  // timestamp — the last thing it did is the best available end.
  const end = item.state === 'running' ? now : lastTs(children, item.ts);
  return { toolCount, running, blocked, elapsedMs: Math.max(0, end - item.ts) };
}

function lastTs(children: TranscriptItem[], fallback: number): number {
  let max = fallback;
  for (const child of children) { if (child.ts > max) { max = child.ts; } }
  return max;
}

/** `4m 12s`, `34s`. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes}m ${total % 60}s` : `${total}s`;
}

/** The word a screen reader gets for a subagent's state. */
export function subagentStateLabel(item: ToolItem, blocked: boolean): string {
  if (blocked) { return 'needs you'; }
  return item.state === 'running' ? 'running' : item.state === 'ok' ? 'done' : 'failed';
}

/**
 * The agent type from a `Task` call's input, when it carries one. This is
 * the identifying fact — "Explore" tells the user what is running, where
 * "Task" is only SDK vocabulary.
 */
export function subagentLabel(item: ToolItem): string {
  const input = item.input;
  if (input && typeof input === 'object' && 'subagent_type' in input) {
    const type = (input as Record<string, unknown>).subagent_type;
    if (typeof type === 'string' && type.length > 0) { return type; }
  }
  return item.name;
}
