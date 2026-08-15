import { cn } from '@/lib/utils';
import { useEffect, useRef } from 'react';
import type { MentionOption } from '../lib/mention-menu';

/**
 * The `@` menu rows. Presentation only — every decision about what is in the
 * list, and what picking one does, lives in `lib/mention-menu.ts` and its
 * source modules.
 *
 * `onMouseDown` with `preventDefault`, not `onClick`: the composer closes the
 * menu on blur, and a click that blurred the textarea first would unmount the
 * row before its handler ran. It sits on the container as well as each row, so
 * a mousedown landing on a heading or on the list's own padding does not blur
 * either.
 */
export function RefMenu<P>({
  rows, activeIndex, listId, onPick,
}: {
  rows: MentionOption<P>[];
  activeIndex: number;
  listId: string;
  onPick: (option: MentionOption<P>) => void;
}) {
  const activeRow = useRef<HTMLDivElement | null>(null);

  // The list overflows `max-h-48` from three sessions up, and arrowing past
  // the fold — or wrapping from the last row back to the first — otherwise
  // moves a highlight the user cannot see. Same effect, same reason, as
  // `invocable-menu.tsx`.
  useEffect(() => {
    activeRow.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  // Grouped for rendering, but the option index stays flat: it is what
  // `aria-activedescendant` and the arrow keys address, and both count rows,
  // not headings.
  const groups: { name: string; rows: { option: MentionOption<P>; index: number }[] }[] = [];
  rows.forEach((option, index) => {
    const last = groups.at(-1);
    if (last?.name === option.group) { last.rows.push({ option, index }); }
    else { groups.push({ name: option.group, rows: [{ option, index }] }); }
  });

  return (
    <div className="flex w-full min-w-0 flex-col" onMouseDown={(e) => e.preventDefault()}>
      <div
        id={listId}
        role="listbox"
        aria-label="Sessions and actions to reference"
        className="max-h-48 overflow-y-auto overscroll-contain"
      >
        {rows.length === 0 && (
          // A row, not an empty box: the listbox has to stay mounted because
          // the textarea's `aria-controls` points at it, and a menu that
          // vanishes mid-keystroke hands Enter back to the composer without
          // the user seeing why. Deliberately not addressable — see the
          // composer, which claims no key while the list has no row.
          <div
            role="option"
            aria-selected={false}
            aria-live="polite"
            className="px-1.5 py-1.5 text-xs text-muted-foreground"
          >
            No match
          </div>
        )}
        {groups.map((group) => (
          // The heading is `aria-hidden` and the name is carried by the
          // group's own label instead: static text is not a legal child of a
          // listbox, and announcing it twice would be worse than either.
          <div key={group.name} role="group" aria-label={group.name}>
            <p
              aria-hidden
              className="px-1.5 pt-1 text-[0.65rem] tracking-wide text-muted-foreground uppercase"
            >
              {group.name}
            </p>
            {group.rows.map(({ option, index }) => (
              <div
                key={option.id}
                ref={index === activeIndex ? activeRow : undefined}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                // The full label, since the one below is truncated at a pane
                // width that leaves two sessions reading the same word.
                title={option.label}
                onMouseDown={(e) => { e.preventDefault(); onPick(option); }}
                className={cn(
                  'flex cursor-pointer items-baseline gap-2 rounded-md px-1.5 py-1.5 text-xs',
                  // Only the inactive rows get a hover fill: twMerge cannot
                  // merge across variants, so shipping both would leave
                  // `.hover\:bg-muted` outranking `.bg-accent` and wipe the
                  // keyboard highlight on hover. Same rule as the `/` menu.
                  index !== activeIndex && 'hover:bg-muted',
                  index === activeIndex
                    && 'bg-accent text-accent-foreground ring-1 ring-ring/40 ring-inset',
                )}
              >
                <span className="min-w-0 truncate font-medium">{option.label}</span>
                <span
                  className={cn(
                    'ml-auto shrink-0 text-muted-foreground',
                    index === activeIndex && 'text-accent-foreground/70',
                  )}
                >
                  {option.hint}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
