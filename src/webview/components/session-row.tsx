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
  session, open, onToggle, onRename,
}: {
  session: SessionSummary;
  open: boolean;
  onToggle: () => void;
  /**
   * Owned by `SessionPicker`, not local state here: this row lives inside
   * the roster's own `DropdownMenuContent`, and clicking a plain
   * `DropdownMenuItem` (unlike a `DropdownMenuSubTrigger`) closes the whole
   * root menu — unmounting this row, and any `open` state on it, before a
   * dialog rendered from it could ever show. `SessionPicker` mounts
   * `RenameSessionDialog` as a sibling of the roster `DropdownMenu` itself,
   * the same place `session-header.tsx` mounts `BringBackDialog` beside its
   * own menu, so the dialog survives the click that opens it.
   */
  onRename: () => void;
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
          // `session.name`, not `session.title`: `name` is always present
          // and unique, unlike `title`, which starts as `'Untitled'` for
          // every session and stays that way until a first send — a shared
          // title would collide across rows and make this label ambiguous.
          aria-label={`More actions for ${session.name}`}
          className="shrink-0 opacity-0 [&>svg:last-child]:hidden group-hover/row:opacity-100 focus:opacity-100 data-popup-open:opacity-100"
        >
          <MoreHorizontalIcon aria-hidden />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onClick={onRename}>
            Rename…
          </DropdownMenuItem>
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
