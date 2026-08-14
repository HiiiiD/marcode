import type { Invocable } from '../../protocol/messages';

/**
 * Rows rendered at most. Bounded DOM instead of a windowing library — this
 * project vendors its UI primitives and takes no new dependencies. Typing
 * narrows below this immediately, so it only ever governs the first view.
 */
export const INVOCABLE_MENU_WINDOW = 50;

/**
 * The composer text -> the active menu query, or `undefined` for "no menu".
 *
 * Trigger discipline: only a leading `/`, and only while no whitespace has
 * been typed. Requiring position 0 keeps `src/foo` and pasted URLs from
 * opening it; closing at the first space means the menu releases Enter as
 * soon as the user starts typing arguments, which is what keeps it from
 * fighting the composer's own send binding.
 */
export function menuQuery(text: string): string | undefined {
  if (!text.startsWith('/')) { return undefined; }
  const rest = text.slice(1);
  if (/\s/.test(rest)) { return undefined; }
  return rest;
}

export function filterInvocables(entries: Invocable[], query: string): Invocable[] {
  if (query.length === 0) { return entries; }
  const needle = query.toLowerCase();

  const scored: { entry: Invocable; rank: number; at: number }[] = [];
  for (const entry of entries) {
    const at = entry.name.toLowerCase().indexOf(needle);
    if (at >= 0) {
      scored.push({ entry, rank: 0, at });
      continue;
    }
    // A description match still surfaces the entry, but never above a name
    // match: the user is typing a name.
    if ((entry.description ?? '').toLowerCase().includes(needle)) {
      scored.push({ entry, rank: 1, at: 0 });
    }
  }

  scored.sort((a, b) =>
    a.rank - b.rank
    || a.at - b.at
    || a.entry.name.localeCompare(b.entry.name));
  return scored.map((s) => s.entry);
}

export function menuView(
  entries: Invocable[], query: string,
): { rows: Invocable[]; overflow: number } {
  const matched = filterInvocables(entries, query);
  return {
    rows: matched.slice(0, INVOCABLE_MENU_WINDOW),
    overflow: Math.max(0, matched.length - INVOCABLE_MENU_WINDOW),
  };
}

/**
 * What selecting an entry does. `text` replaces the composer contents;
 * `ghost` is presentation-only and must never be appended to the message —
 * see the composer's submit path and its DOM test.
 */
export function insertionFor(entry: Invocable): { text: string; ghost: string } {
  return { text: `/${entry.name} `, ghost: entry.argHint ?? '' };
}

/**
 * Middle-truncate, keeping the plugin prefix and the leaf — the two halves
 * that identify an entry. Callers put the full name in a title attribute.
 */
export function truncateName(name: string, max = 34): string {
  if (name.length <= max) { return name; }
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

export type MenuKeyAction = 'move-up' | 'move-down' | 'select' | 'close' | 'pass';

/**
 * Which keys the menu claims WHILE OPEN. Everything else passes through to
 * the composer; a handler that claimed keys after close would stop Enter
 * from sending, which is worse than having no menu at all.
 */
export function menuKeyAction(key: string): MenuKeyAction {
  switch (key) {
    case 'ArrowDown': return 'move-down';
    case 'ArrowUp': return 'move-up';
    case 'Enter': case 'Tab': return 'select';
    case 'Escape': return 'close';
    default: return 'pass';
  }
}

/** Wrapping highlight movement. Returns 0 for an empty list rather than -1. */
export function nextIndex(current: number, delta: number, length: number): number {
  if (length <= 0) { return 0; }
  return (current + delta + length) % length;
}
