import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ListIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { useStore } from "../store";
import { assignAt, leafSessionIds, removeSlotAt } from "./layout-tree";
import { createMessage, inheritedSettings } from "./session-create-settings";
import { SessionCreateDialog } from "./session-create-dialog";

interface EmptySlotProps {
  /** This leaf's own path — where a created or picked session should land. */
  path: number[];
}

/**
 * An empty leaf's placeholder. Disabled "New session" carries no reason text
 * of its own: `inheritedSettings` being `undefined` means there is no
 * provider to create against, a panel-wide fact the toolbar already surfaces.
 * Dragging a session's header onto the slot is the third way to fill it.
 */
export function EmptySlot({ path }: EmptySlotProps) {
  const { state, post, setPendingSlot } = useStore();
  const [open, setOpen] = useState(false);
  const settings = inheritedSettings(state);
  const placed = new Set(leafSessionIds(state.layout.root));
  const hidden = state.sessions.filter((s) => !placed.has(s.id));

  const postRoot = (root: typeof state.layout.root) => post({ t: "set-layout", layout: { ...state.layout, root } });

  return (
    <div role="group" aria-label="Empty slot" className={cn("flex h-full flex-col items-center justify-center gap-1.5 border border-dashed border-border/60 p-2")}>
      <Button variant="outline" size="sm" disabled={!settings} onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden />
        New session
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={hidden.length === 0} />}>
          <ListIcon aria-hidden />
          Pick from roster
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center">
          {hidden.map((s) => (
            <DropdownMenuItem
              key={s.id}
              onClick={() => {
                const next = assignAt(state.layout.root, path, s.id);
                if (next) { postRoot(next); }
              }}
            >
              {s.title}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="sm"
        disabled={path.length === 0}
        onClick={() => postRoot(removeSlotAt(state.layout.root, path))}
      >
        <Trash2Icon aria-hidden />
        Remove slot
      </Button>
      {settings && (
        <SessionCreateDialog
          open={open}
          onOpenChange={setOpen}
          catalog={state.catalog}
          initial={settings}
          onCreate={(chosen, _seed, worktree) => {
            // Set before posting: `app.tsx`'s reconcile effect reads this the
            // moment the new session's snapshot arrives, and that can race
            // ahead of this component's own next render.
            setPendingSlot(path);
            post(createMessage(chosen, undefined, worktree));
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
