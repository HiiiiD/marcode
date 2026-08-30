// Pure helper for FleetApp's per-session subagent list — kept free of React
// so it unit-tests without mounting anything, the same split
// active-subagents.ts and subagent-window.ts use.
import type { TranscriptItem } from '../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

/**
 * A session's top-level subagent tool calls — never a subagent's own
 * children (depth stays capped at 1, same as everywhere else in this
 * codebase), never a plain tool call, and never a non-tool item. Running by
 * default; `includeSettled` reveals `ok`/`error` ones too. Oldest first,
 * matching `active-subagents.ts`'s ordering, so a list that grows over a
 * session's lifetime doesn't reorder rows the user has already scanned.
 */
export function filterSubagents(
  items: TranscriptItem[],
  opts: { includeSettled: boolean },
): ToolItem[] {
  return items
    .filter((item): item is ToolItem => item.role === 'tool' && item.tool.kind === 'subagent')
    .filter((item) => opts.includeSettled || item.state === 'running')
    .sort((a, b) => a.ts - b.ts);
}
