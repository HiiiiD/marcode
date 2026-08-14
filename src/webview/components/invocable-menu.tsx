import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { truncateName } from '../lib/invocable-menu';
import type { Invocable } from '../../protocol/messages';

/**
 * The `/` autocomplete list. A pure renderer: every rule about what to show,
 * in what order, and which key does what lives in `../lib/invocable-menu` and
 * is unit-tested there. This file decides only how a row looks.
 *
 * It renders inside the composer's `block-start` addon rather than a popover:
 * a 300px sidebar has nowhere to float a panel, and an in-flow list needs no
 * positioning maths, no portal, and no escape-hatch for the pane's own
 * scroll container.
 *
 * Focus never comes here. The textarea keeps it for the whole interaction and
 * carries `aria-activedescendant` — ARIA only honours that attribute on the
 * focused element — so every row is a plain `div`, not a tab stop.
 */
export function InvocableMenu({ rows, overflow, activeIndex, listId, onPick }: {
  rows: Invocable[];
  overflow: number;
  activeIndex: number;
  /** Prefix for row ids, so `aria-activedescendant` resolves per pane. */
  listId: string;
  onPick: (entry: Invocable) => void;
}) {
  const empty = rows.length === 0;
  const activeRow = useRef<HTMLDivElement | null>(null);

  // Up to 50 rows in a `max-h-56` box: arrowing past the fold — or wrapping
  // from the last row back to the first — otherwise moves a highlight the
  // user cannot see. `block: 'nearest'` scrolls only when it has to, so
  // stepping through visible rows does not jerk the list.
  useEffect(() => {
    activeRow.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    // onMouseDown here, not just on each row: without it, a mousedown on the
    // `+N more` line, the listbox's own padding, or this container's edge
    // blurs the textarea before a click ever reaches a row's handler, which
    // closes the menu out from under the user.
    <div className="flex w-full min-w-0 flex-col" onMouseDown={(e) => e.preventDefault()}>
      <div
        role="listbox"
        aria-label="Skills and commands"
        id={listId}
        aria-activedescendant={empty ? undefined : `${listId}-${activeIndex}`}
        className="max-h-56 w-full overflow-y-auto overscroll-contain"
      >
        {empty && (
          // A row, not an empty box: a menu that vanishes mid-keystroke hands
          // Enter back to the composer without the user seeing why.
          //
          // `aria-live`, not `role="status"`: a status role would take this
          // out of the option list, and "exactly one row" is both the design
          // contract and what the tests count. The polite announcement is
          // what a screen-reader user gets instead of silence after typing a
          // query that matches nothing.
          <div
            role="option"
            aria-selected={false}
            aria-live="polite"
            className="px-1.5 py-1.5 text-xs text-muted-foreground"
          >
            No match
          </div>
        )}
        {rows.map((entry, i) => (
          <div
            // Positional, not `entry.name`: names cross the host/webview seam
            // verbatim and are never deduped there, so two entries — a user
            // skill and a plugin skill sharing a name, say — would collide on
            // a name-only key. A duplicate key produces a React warning and
            // can leave `scrollIntoView` targeting the wrong row's ref after
            // a filter change re-keys the list.
            key={`${i}-${entry.name}`}
            ref={i === activeIndex ? activeRow : undefined}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === activeIndex}
            // The full name, since the label above is middle-truncated.
            title={entry.name}
            // onMouseDown, not onClick: the textarea must not lose focus
            // before the pick lands, or the composer's blur-close fires first
            // and the click lands on a row that is already unmounted.
            onMouseDown={(e) => { e.preventDefault(); onPick(entry); }}
            className={cn(
              'cursor-pointer rounded-md px-1.5 py-1.5',
              // Only the inactive rows get a hover fill. twMerge cannot merge
              // across variants, so shipping both leaves `.hover\:bg-muted`
              // (two class selectors) outranking `.bg-accent` (one) whatever
              // the source order — hovering the keyboard-active row would
              // wipe its highlight and strand `text-accent-foreground` on an
              // unchecked background.
              i !== activeIndex && 'hover:bg-muted',
              // Fill *plus* the ring this project uses for the focused pane —
              // the highlight has to survive a user who cannot separate the
              // accent fill from the surface behind it.
              i === activeIndex && 'bg-accent text-accent-foreground ring-1 ring-ring/40 ring-inset',
            )}
          >
            <div className="flex items-baseline gap-2">
              <span className="truncate text-sm font-medium">{truncateName(entry.name)}</span>
              {entry.origin && (
                <span
                  className={cn(
                    'ml-auto shrink-0 text-[0.65rem] text-muted-foreground',
                    i === activeIndex && 'text-accent-foreground/70',
                  )}
                >
                  {entry.origin}
                </span>
              )}
            </div>
            {entry.description && (
              <div
                className={cn(
                  'truncate text-xs text-muted-foreground',
                  i === activeIndex && 'text-accent-foreground/80',
                )}
              >
                {entry.description}
              </div>
            )}
          </div>
        ))}
      </div>
      {overflow > 0 && (
        // A sibling of the listbox, not a child: `<p>` is not a legal child of
        // `role="listbox"`, and this is a count rather than something the
        // arrow keys can land on.
        <p className="px-1.5 py-1 text-[0.65rem] text-muted-foreground">
          {overflow} more — keep typing to narrow
        </p>
      )}
    </div>
  );
}
