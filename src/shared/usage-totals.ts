import type { UsageTotals } from '../providers/types';

/**
 * Adds a delta onto a running total. `undefined` in means "no turns yet" —
 * the delta becomes the whole running total, not zero plus itself, so the
 * caller never has to special-case the first turn.
 */
export function addUsageTotals(running: UsageTotals | undefined, delta: UsageTotals): UsageTotals {
  return {
    inputTokens: (running?.inputTokens ?? 0) + delta.inputTokens,
    outputTokens: (running?.outputTokens ?? 0) + delta.outputTokens,
    cacheReadTokens: (running?.cacheReadTokens ?? 0) + delta.cacheReadTokens,
    cacheCreationTokens: (running?.cacheCreationTokens ?? 0) + delta.cacheCreationTokens,
  };
}

/** Sums a list of totals — e.g. several Codex subagent threads into one `subagent` bucket. */
export function sumUsageTotals(list: UsageTotals[]): UsageTotals {
  return list.reduce<UsageTotals>(
    (acc, next) => addUsageTotals(acc, next),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  );
}
