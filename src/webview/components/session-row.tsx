import { MoreHorizontalIcon } from 'lucide-react';
import {
  DropdownMenuCheckboxItem, DropdownMenuItem,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { useStore } from '../store';
import type { SessionSummary } from '../../protocol/messages';

/**
 * The actions menu is a submenu rather than local state plus a swapped-in
 * pair of buttons. A nested <button> inside a menuitemcheckbox is not
 * reachable by the menu's arrow-key roving focus, so the hover-revealed icon
 * would be mouse-only. A SubmenuTrigger *is* a menu item: ArrowRight opens it,
 * Escape backs out, and the delete confirm costs no custom focus management.
 *
 * Archive and delete both live under this one "More actions" trigger —
 * archive fires directly (it is recoverable: an archived session still
 * shows up here, grouped, and can be reopened), delete is nested one level
 * deeper behind its own confirm because it is not.
 */
export function SessionRow({
  session, open, onToggle,
}: {
  session: SessionSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const { post } = useStore();

  return (
    // A plain div, not `DropdownMenuGroup`: `Menu.Group` (see
    // node_modules/@base-ui/react/menu/group/MenuGroup.js) renders
    // `role="group"` unconditionally, and this wrapper exists only for the
    // `flex items-center gap-1` layout, not to group menu semantics — every
    // roster row would otherwise announce an unnamed group boundary, and an
    // archived row would nest a second unnamed group inside the named
    // `Archived (n)` group below it. Base UI's roving focus tracks items via
    // context refs, not DOM structure, so arrow-key navigation across rows
    // is unaffected by dropping the `Menu.Group` wrapper here.
    <div className="group/row flex items-center gap-1">
      <DropdownMenuCheckboxItem
        checked={open}
        onCheckedChange={onToggle}
        className="min-w-0 flex-1"
      >
        <span className="truncate">{session.title}</span>
      </DropdownMenuCheckboxItem>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger
          aria-label={`More actions for ${session.title}`}
          className="shrink-0 opacity-0 [&>svg:last-child]:hidden group-hover/row:opacity-100 focus:opacity-100 data-popup-open:opacity-100"
        >
          <MoreHorizontalIcon aria-hidden />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onClick={() => post({ t: 'close-session', id: session.id })}>
            Archive {session.title}
          </DropdownMenuItem>

          {/*
            Base UI focuses the submenu's first item on open (`focusItemOnOpen`
            defaults to 'auto'). ArrowRight then Enter is the natural "open
            and activate" gesture for a keyboard user, so the destructive
            action must never be first — "Keep it" is listed before "Delete"
            below so the default landing spot is the safe one, one level of
            nesting deeper than the "Archive"/"Delete…" split above.
          */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger aria-label={`Delete session ${session.title}`}>
              Delete…
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Keep it</DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => post({ t: 'delete-session', id: session.id })}
              >
                Delete {session.title}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </div>
  );
}
