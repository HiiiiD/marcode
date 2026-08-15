import { cn } from '@/lib/utils';
import type { MentionOption } from '../lib/mention-menu';

/**
 * The `@` menu rows. Presentation only — every decision about what is in the
 * list, and what picking one does, lives in `lib/mention-menu.ts` and its
 * source modules.
 *
 * `onMouseDown` with `preventDefault`, not `onClick`: the composer closes the
 * menu on blur, and a click that blurred the textarea first would unmount the
 * row before its handler ran.
 */
export function RefMenu<P>({
  rows, activeIndex, listId, onPick,
}: {
  rows: MentionOption<P>[];
  activeIndex: number;
  listId: string;
  onPick: (option: MentionOption<P>) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-2 py-1 text-xs text-muted-foreground">No sessions to reference</p>
    );
  }

  return (
    <ul id={listId} role="listbox" className="max-h-48 overflow-y-auto">
      {rows.map((option, i) => (
        <li
          key={option.id}
          id={`${listId}-${i}`}
          role="option"
          aria-selected={i === activeIndex}
          onMouseDown={(e) => { e.preventDefault(); onPick(option); }}
          className={cn(
            'flex cursor-pointer items-baseline gap-2 rounded-sm px-2 py-1 text-xs',
            i === activeIndex && 'bg-accent text-accent-foreground',
          )}
        >
          <span className="min-w-0 truncate font-medium">{option.label}</span>
          <span className="ml-auto shrink-0 text-muted-foreground">{option.hint}</span>
        </li>
      ))}
    </ul>
  );
}
