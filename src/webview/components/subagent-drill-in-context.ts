import { createContext, useContext } from 'react';

/**
 * How a `SubagentCard` asks its pane to replace itself with this subagent's
 * full, unwindowed transcript. Provided by `PaneGroup` around each pane's
 * subtree (see pane-group.tsx); absent in any other host (a test harness
 * that mounts `SubagentCard` directly, the review tab), where it is a no-op
 * rather than a crash — the affordance simply does nothing there, which is
 * correct since neither host has a pane to drill into.
 */
export const SubagentDrillInContext = createContext<((itemId: string) => void) | undefined>(
  undefined,
);

export function useOpenSubagentTranscript(): (itemId: string) => void {
  return useContext(SubagentDrillInContext) ?? (() => {});
}
