import type { UsageWindow } from '../providers/types';

/**
 * The order the strip renders windows in, shortest window first. Fixed, and
 * never derived from utilization: a strip that reorders itself as the numbers
 * move cannot be read at a glance.
 *
 * It lives in `shared/` because two modules need it and neither should own
 * the other's table — the Claude mapper assigns these ids (see
 * `WINDOW_LABELS` in providers/claude/map-context.ts), and SessionManager,
 * which must not import a provider's internals, sorts by them.
 */
export const USAGE_WINDOW_ORDER: readonly string[] = [
  'five-hour', 'seven-day', 'seven-day-opus', 'seven-day-sonnet',
];

/**
 * Known ids first in table order, then anything else by id. A provider that
 * reports a window this table has never heard of still renders — at the end,
 * deterministically — rather than vanishing.
 */
export function orderWindows(windows: UsageWindow[]): UsageWindow[] {
  const rank = (id: string) => {
    const i = USAGE_WINDOW_ORDER.indexOf(id);
    return i === -1 ? USAGE_WINDOW_ORDER.length : i;
  };
  return [...windows].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}
