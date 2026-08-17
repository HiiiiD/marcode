import { useCallback, useState, type KeyboardEvent } from 'react';

/**
 * Where a key takes the roving focus, or `null` when the key is not ours.
 *
 * Pure, and separated from the hook so the movement rules are unit-testable
 * without a DOM. Clamped rather than wrapping: in a list built to carry 500
 * rows, wrapping means an ArrowUp at the top teleports the reader into a
 * different session's work with no indication it happened.
 */
export function nextIndex(current: number, key: string, count: number): number | null {
  if (count === 0) { return null; }
  switch (key) {
    case 'ArrowDown': return Math.min(current + 1, count - 1);
    case 'ArrowUp': return Math.max(current - 1, 0);
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

/**
 * One row in the tab order, arrows to move between them.
 *
 * Every row used to be an independent `Button`, so reaching row 400 meant 400
 * Tab presses — the single largest reason the surface scored 1/4 on
 * flexibility and efficiency.
 */
export function useRovingRows(count: number) {
  const [active, setActive] = useState(0);
  const clamped = Math.min(active, Math.max(count - 1, 0));

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const next = nextIndex(clamped, e.key, count);
    if (next === null) { return; }
    e.preventDefault();
    setActive(next);
    // Focus follows the roving index: the row is the thing the user is on, and
    // a visual highlight the screen reader cannot see is not navigation.
    const rows = e.currentTarget.querySelectorAll<HTMLElement>('[data-review-row]');
    rows[next]?.focus();
  }, [clamped, count]);

  return { active: clamped, setActive, onKeyDown };
}
