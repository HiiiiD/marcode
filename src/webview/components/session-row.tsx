import { Trash2Icon } from 'lucide-react';
import {
  DropdownMenuCheckboxItem, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { useStore } from '../store';
import type { SessionSummary } from '../../protocol/messages';

/**
 * The delete confirm is a submenu rather than local state plus a swapped-in
 * pair of buttons. A nested <button> inside a menuitemcheckbox is not
 * reachable by the menu's arrow-key roving focus, so the hover-revealed icon
 * would be mouse-only. A SubmenuTrigger *is* a menu item: ArrowRight opens it,
 * Escape backs out, and the confirm costs no custom focus management.
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
    <DropdownMenuGroup className="group/row flex items-center gap-1">
      <DropdownMenuCheckboxItem
        checked={open}
        onCheckedChange={onToggle}
        className="min-w-0 flex-1"
      >
        <span className="truncate">{session.title}</span>
        {session.archived && (
          <span className="ml-auto pl-2 text-muted-foreground">archived</span>
        )}
      </DropdownMenuCheckboxItem>

      {/*
        Base UI focuses the submenu's first item on open (`focusItemOnOpen`
        defaults to 'auto'). ArrowRight then Enter is the natural "open and
        activate" gesture for a keyboard user, so the destructive action must
        never be first — "Keep it" is listed before "Delete" below so the
        default landing spot is the safe one.
      */}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger
          aria-label={`Delete session ${session.title}`}
          className="shrink-0 opacity-0 [&>svg:last-child]:hidden group-hover/row:opacity-100 focus:opacity-100 data-popup-open:opacity-100"
        >
          <Trash2Icon aria-hidden />
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
    </DropdownMenuGroup>
  );
}
