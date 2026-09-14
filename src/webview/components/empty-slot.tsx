import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { PlusIcon } from "lucide-react";
import type { SessionSummary } from "../../protocol/messages";

interface EmptySlotProps {
  /** Roster sessions not currently placed anywhere in the tree — the only sessions this slot can legally take. */
  assignable: SessionSummary[];
  onAssign: (sessionId: string) => void;
}

/**
 * An empty leaf's placeholder — assign-picker only, no create-a-new-session
 * affordance here (that's `SessionCreateMenu`, in the toolbar, unrelated to
 * a specific leaf). If there is nothing left to assign, the button still
 * renders (a stable, always-real slot) but disabled with a reason, matching
 * this panel's "an action that can only ever refuse is worse than an absent
 * one" convention elsewhere — except here the refusal is transient (every
 * roster session is already placed) rather than permanent, so keeping the
 * door visible-but-disabled is honest instead of misleading.
 */
export function EmptySlot({ assignable, onAssign }: EmptySlotProps) {
  return (
    <div className={cn("flex h-full items-center justify-center border border-dashed border-border/60")}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" disabled={assignable.length === 0} />}
        >
          <PlusIcon aria-hidden />
          {assignable.length === 0 ? "No sessions to assign" : "Assign a session…"}
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {assignable.map((s) => (
            <DropdownMenuItem key={s.id} onClick={() => onAssign(s.id)}>
              {s.title}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
