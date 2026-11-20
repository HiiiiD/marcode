import { Fragment, useEffect, useRef } from 'react';
import { MenuGroupLabel, MenuRow, menuListClass, useScrollCue } from './menu-list';
import { truncateName } from '../../client-core/invocables/invocable-menu';
import type { Invocable } from '../../protocol/messages';

/**
 * The `/` autocomplete list. A pure renderer: every rule about what to show,
 * in what order, and which key does what lives in `client-core/invocables/invocable-menu` and
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
const groupOf = (e: Invocable) => e.origin ?? 'Commands';

/** One header per source: commands first, then the rest alphabetically. Stable inside a group, so relevance order survives. */
export function groupInvocables(rows: Invocable[]): Invocable[] {
  const rank = (e: Invocable) => (groupOf(e) === 'Commands' ? 0 : 1);
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => rank(a.row) - rank(b.row)
      || (rank(a.row) === 0 ? 0 : groupOf(a.row).localeCompare(groupOf(b.row)))
      || a.i - b.i)
    .map((x) => x.row);
}

export function InvocableMenu({ rows, overflow, activeIndex, listId, onPick }: {
  rows: Invocable[];
  overflow: number;
  activeIndex: number;
  /** Prefix for row ids, so `aria-activedescendant` resolves per pane. */
  listId: string;
  onPick: (entry: Invocable) => void;
}) {
  const empty = rows.length === 0;
  const grouped = rows.some((r) => r.origin);
  const cue = useScrollCue();
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
        ref={cue.ref}
        onScroll={cue.onScroll}
        className={menuListClass(cue.more)}
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
        {rows.map((entry, i) => {
          const group = groupOf(entry);
          const heading = grouped && (i === 0 || groupOf(rows[i - 1]) !== group);
          return (
            // Positional key: names are never deduped across the host/webview seam.
            <Fragment key={`${i}-${entry.name}`}>
              {heading && <MenuGroupLabel>{group}</MenuGroupLabel>}
              <MenuRow
                rowRef={i === activeIndex ? activeRow : undefined}
                id={`${listId}-${i}`}
                active={i === activeIndex}
                title={entry.name}
                label={truncateName(entry.name)}
                detail={entry.description}
                // onMouseDown, not onClick: a blur before the pick closes the menu first.
                onPick={() => onPick(entry)}
              />
            </Fragment>
          );
        })}
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
