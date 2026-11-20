import { useEffect, useRef } from 'react';
import { MenuGroupLabel, MenuRow, menuListClass, useScrollCue } from './menu-list';
import type { MentionOption } from '../../client-core/mentions/mention-menu';

/**
 * The `@` menu rows. Presentation only — every decision about what is in the
 * list, and what picking one does, lives in `client-core/mentions/mention-menu.ts` and its
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
  const cue = useScrollCue();
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
        ref={cue.ref}
        onScroll={cue.onScroll}
        className={menuListClass(cue.more)}
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
            <MenuGroupLabel>{group.name}</MenuGroupLabel>
            {group.rows.map(({ option, index }) => (
              <MenuRow
                key={option.id}
                rowRef={index === activeIndex ? activeRow : undefined}
                id={`${listId}-${index}`}
                active={index === activeIndex}
                title={option.label}
                label={option.label}
                detail={option.hint}
                onPick={() => onPick(option)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
