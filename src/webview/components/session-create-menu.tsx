import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { useStore } from "../store";
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
 */
export function SessionCreateMenu() {
  const { state, post } = useStore();
  const [open, setOpen] = useState(false);
  const settings = inheritedSettings(state);

  return (
    <>
      <ButtonGroup className="shrink-0">
        <Button
          size="sm"
          aria-label="New session"
          disabled={!settings}
          onClick={() => settings && post(createMessage(settings))}
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
          onCreate={(chosen) => {
            post(createMessage(chosen));
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
