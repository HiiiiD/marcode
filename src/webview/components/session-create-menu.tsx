import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { useStore } from "../store";
import { flattenLeaves } from "./layout-tree";
import { SessionCreateDialog } from "./session-create-dialog";
import { createMessage, inheritedSettings } from "./session-create-settings";

/**
 * Two controls in one group: the session you almost always want, and the
 * one you occasionally don't.
 *
 * `+ New` asks nothing — it copies the provider, model, effort and
 * permission mode of the session the user is working in and creates. The
 * caret opens the full form. This replaced a menu that made every creation
 * cost two clicks and a read, to answer questions whose answer was already
 * on screen.
 *
 * If an empty slot already exists anywhere in the layout, either path fills
 * that slot instead of appending a new top-level pane — `flattenLeaves`
 * walks the tree depth-first, so the first hit is the same reading-order
 * slot a user scanning the grid would call "the empty one." See
 * `ClientState.pendingSlotPath`.
 */
export function SessionCreateMenu() {
  const { state, post, setPendingSlot } = useStore();
  const [open, setOpen] = useState(false);
  const settings = inheritedSettings(state);

  const create = (chosen: typeof settings, worktree?: { branch: string; base?: string }) => {
    if (!chosen) { return; }
    const emptySlot = flattenLeaves(state.layout.root).find((l) => l.sessionId === null);
    if (emptySlot) { setPendingSlot(emptySlot.path); }
    post(createMessage(chosen, undefined, worktree));
  };

  return (
    <>
      <ButtonGroup className="shrink-0">
        <Button
          size="sm"
          aria-label="New session"
          disabled={!settings}
          onClick={() => create(settings)}
        >
          <PlusIcon aria-hidden />
          New
        </Button>
        <Button
          size="sm"
          aria-label="New session with options"
          title="New session with options"
          disabled={!settings}
          onClick={() => setOpen(true)}
        >
          <ChevronDownIcon aria-hidden />
        </Button>
      </ButtonGroup>
      {settings && (
        <SessionCreateDialog
          open={open}
          onOpenChange={setOpen}
          catalog={state.catalog}
          initial={settings}
          onCreate={(chosen, _seed, worktree) => {
            create(chosen, worktree);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
