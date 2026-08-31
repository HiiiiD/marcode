import { createContext, useContext } from 'react';

/**
 * How a `SubagentCard` asks the host to open the Fleet tab focused on this
 * subagent. `PaneGroup` provides a callback around each pane's subtree (see
 * pane-group.tsx) that posts `{ t: 'open-fleet-subagent', sessionId, itemId }`
 * to the host; absent in any other host (a test harness that mounts
 * `SubagentCard` directly, the review tab), where it is a no-op rather than a
 * crash — the affordance simply does nothing there, which is correct since
 * posting a message needs no pane at all, unlike the retired in-pane drill-in
 * this replaced, which needed one to swap its content.
 */
export const SubagentDrillInContext = createContext<((itemId: string) => void) | undefined>(
  undefined,
);

export function useOpenSubagentTranscript(): (itemId: string) => void {
  return useContext(SubagentDrillInContext) ?? (() => {});
}
