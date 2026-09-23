import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { useStore } from "../store";
import { createMessage, inheritedSettings } from "./session-create-settings";
import { SessionCreateDialog } from "./session-create-dialog";

interface EmptySlotProps {
  /** This leaf's own path — where the session the dialog creates should land, not wherever `+ New` would otherwise append it. */
  path: number[];
}

/**
 * An empty leaf's placeholder: one "New" button, opening the same create
 * dialog the toolbar's caret does. There is no assign-an-existing-session
 * picker here anymore — dragging a session's header onto this leaf (see
 * `layout-node-view.tsx`'s drop handling) is the way to place one that
 * already exists; this button is for one that doesn't yet. Disabled, with
 * no reason text of its own, exactly when the toolbar's own create controls
 * are: `inheritedSettings` returning `undefined` means there is no provider
 * to create against at all, a panel-wide fact the toolbar already surfaces.
 */
export function EmptySlot({ path }: EmptySlotProps) {
  const { state, post, setPendingSlot } = useStore();
  const [open, setOpen] = useState(false);
  const settings = inheritedSettings(state);

  return (
    <div className={cn("flex h-full items-center justify-center border border-dashed border-border/60")}>
      <Button
        variant="outline"
        size="sm"
        disabled={!settings}
        onClick={() => setOpen(true)}
      >
        <PlusIcon aria-hidden />
        New
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
