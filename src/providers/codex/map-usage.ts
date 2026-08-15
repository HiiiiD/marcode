import type { ContextBreakdown, UsageWindow } from '../types';
import type { RateLimitSnapshot, RateLimitWindow, ThreadTokenUsage } from './wire';

/**
 * Codex names its windows by duration rather than by id, so the label is
 * derived. 300 minutes and 10080 minutes are the two the plans actually use;
 * anything else gets its duration spelled out rather than a wrong guess.
 */
function labelFor(minutes: number | null): string {
  if (minutes === null) { return 'Plan usage'; }
  if (minutes === 300) { return 'Session (5h)'; }
  if (minutes === 10_080) { return 'Week'; }
  if (minutes % 1440 === 0) { return `${minutes / 1440}d`; }
  if (minutes % 60 === 0) { return `${minutes / 60}h`; }
  return `${minutes}m`;
}

/**
 * Codex documents no unit for `resetsAt`; it is epoch **seconds**.
 *
 * Measured against a live account on codex-cli 0.147.0: 1787337648 against a
 * wall clock of 1786736436s, 6.96 days out on a 10080-minute window.
 * `UsageWindow.resetsAt` is epoch milliseconds, so this converts.
 *
 * Do not "simplify" this away. CLAUDE.md records that the sibling Claude
 * provider carries both scales — epoch seconds on the event, ISO strings on
 * the structured response — and mixing them is a live bug class here.
 */
function toMs(resetsAt: number | null): number | undefined {
  return resetsAt === null ? undefined : resetsAt * 1000;
}

function windowOf(id: string, w: RateLimitWindow | null): UsageWindow | undefined {
  if (!w) { return undefined; }
  return {
    id,
    label: labelFor(w.windowDurationMins),
    usedPercent: w.usedPercent,
    resetsAt: toMs(w.resetsAt),
  };
}

/**
 * Plan usage as percentages.
 *
 * `usedPercent` is already a percentage, so nothing here converts a token
 * count — the "usage surfaces show percentages, never token counts"
 * invariant holds without work. An absent window is omitted rather than
 * reported as 0%: "not reported" and "none used" are different facts.
 */
export function toUsageWindows(snapshot: RateLimitSnapshot): UsageWindow[] {
  return [windowOf('primary', snapshot.primary), windowOf('secondary', snapshot.secondary)]
    .filter((w): w is UsageWindow => w !== undefined);
}

/**
 * Context occupancy as percentages of the model's window.
 *
 * Codex reports totals, not the system/memory/conversation split the Claude
 * provider gets, so everything used lands in `conversationPercent` and the
 * other two slices are honestly zero. `memoryFiles` is empty for the same
 * reason: the popover renders what it is given, and inventing rows would be
 * worse than an empty list.
 *
 * `freePercent` is computed as the remainder rather than independently, so
 * the four fields sum to exactly 100 as the interface requires.
 */
export function toContextBreakdown(usage: ThreadTokenUsage): ContextBreakdown | undefined {
  const window = usage.modelContextWindow;
  if (!window || window <= 0) { return undefined; }
  const used = Math.min(100, Math.round((usage.total.totalTokens / window) * 100));
  return {
    systemPercent: 0,
    memoryPercent: 0,
    conversationPercent: used,
    freePercent: 100 - used,
    memoryFiles: [],
  };
}
