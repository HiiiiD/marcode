import {
  useCallback, useEffect, useRef, useState, type KeyboardEvent,
} from 'react';

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
 *
 * Takes the row *keys*, in render order, not a bare count. This surface
 * polls every 750ms while agents work and rebuilds its row list from
 * whatever order the host sent, so a number alone is not stable identity —
 * a file created between two polls that sorts earlier shifts every later row
 * down by one while a bare index keeps pointing at the old position, and the
 * next arrow key or "Open the next file" would silently open the wrong file.
 * The index here is *derived* from `activeKey` every render (`keys.indexOf`),
 * so the roving position follows the row it was on, not the slot it was in,
 * and only falls back to a clamped position when that row is genuinely gone
 * — filtered out, or its group or tree collapsed.
 */
export function useRovingRows(keys: string[]) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // The last resolved numeric position, kept only so a vanished row has
  // somewhere to fall back near instead of snapping to the top of a
  // 500-row list.
  const lastIndexRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  // Set once real DOM focus ever lands inside the list. Distinguishes "the
  // active row's node just disappeared out from under a focused list" (worth
  // recovering) from "nothing has been focused yet" (mounting the surface
  // must never steal focus on its own).
  const hadFocusRef = useRef(false);

  let index = activeKey !== null ? keys.indexOf(activeKey) : -1;
  if (index === -1) {
    index = keys.length === 0 ? -1 : Math.min(lastIndexRef.current, keys.length - 1);
  }
  // Render-phase state sync — React's own documented pattern for adjusting
  // state from a changed input — rather than an effect, so the reconciled
  // key is correct on the same render the row list changed, not one render
  // late.
  if (index !== -1 && keys[index] !== activeKey) {
    setActiveKey(keys[index]);
  }
  lastIndexRef.current = index === -1 ? 0 : index;

  const focusRow = useCallback((i: number) => {
    hadFocusRef.current = true;
    const container = containerRef.current;
    if (container === null) { return; }
    const rows = container.querySelectorAll<HTMLElement>('[data-review-row]');
    (rows[i] ?? container).focus();
  }, []);

  const setActive = useCallback((i: number) => {
    lastIndexRef.current = i;
    setActiveKey(keys[i] ?? null);
  }, [keys]);

  // Marks a row as focused *and* records that the list has real DOM focus —
  // distinct from `setActive`, which the next/prev header controls also use
  // without a genuine focus event behind it.
  const onRowFocus = useCallback((i: number) => {
    hadFocusRef.current = true;
    setActive(i);
  }, [setActive]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const next = nextIndex(index, e.key, keys.length);
    if (next === null) { return; }
    e.preventDefault();
    setActive(next);
    // Focus follows the roving index: the row is the thing the user is on, and
    // a visual highlight the screen reader cannot see is not navigation.
    focusRow(next);
  }, [index, keys.length, setActive, focusRow]);

  // Rows are keyed by path, so React reuses the DOM node while a file is
  // present — but filtering it out, or collapsing its group or tree, unmounts
  // it and takes the browser's focus with it, straight to `document.body`.
  // Nothing else here restores it: the next Tab press would silently
  // re-enter the page's tab order from the top instead of resuming in the
  // list. Only acts once the list has genuinely held focus, and only when
  // focus has actually been dropped — never on mount, and never while focus
  // is legitimately somewhere else (a header control, the filter input).
  useEffect(() => {
    if (!hadFocusRef.current) { return; }
    if (document.activeElement !== document.body) { return; }
    focusRow(index === -1 ? 0 : index);
  });

  return {
    active: index, setActive, onKeyDown, containerRef, focusRow, onRowFocus,
    // Whether real DOM focus has ever landed in the list — distinct from
    // `active`, which resolves to `0` even on a fresh mount nothing has
    // touched. Callers use it to tell "the reader is genuinely on row 0" from
    // "row 0 is just where the index defaults to" — see the "Open the next
    // file" header control, which must open row 0 rather than row 1 the first
    // time it is pressed on a tab nobody has focused yet.
    hadFocus: hadFocusRef.current,
  };
}
