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

  return (
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
        <div
          role="option"
          aria-selected={false}
          className="px-1.5 py-1.5 text-xs text-muted-foreground"
        >
          No match
        </div>
      )}
      {rows.map((entry, i) => (
        <div
          key={entry.name}
          id={`${listId}-${i}`}
          role="option"
          aria-selected={i === activeIndex}
          // The full name, since the label above is middle-truncated.
          title={entry.name}
          // onMouseDown, not onClick: the textarea must not lose focus before
          // the pick lands, or the menu closes on blur and the click is lost.
          onMouseDown={(e) => { e.preventDefault(); onPick(entry); }}
          className={cn(
            'cursor-pointer rounded-md px-1.5 py-1.5 hover:bg-muted',
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
      {overflow > 0 && (
        // Not a row: it is a count, not something the arrow keys can land on.
        <p className="px-1.5 py-1 text-[0.65rem] text-muted-foreground">
          {overflow} more — keep typing to narrow
        </p>
      )}
    </div>
  );
}
