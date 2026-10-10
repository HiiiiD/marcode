import { SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PaneState } from "../../client-core/reducer";
import { runningShell } from "../../client-core/running-shell";
import type { SessionId } from "../../protocol/messages";
import { useStore } from "../store";

/**
 * The card for a running command scrolls away with the transcript, so the one
 * control that can stop it is mirrored here, above the composer.
 */
export function PinnedShell({ pane, sessionId }: { pane: PaneState; sessionId: SessionId }) {
  const { post } = useStore();
  const item = pane.summary.owner ? undefined : runningShell(pane.items);
  if (!item) { return null; }
  return (
    <div
      role="region"
      aria-label="Running shell command"
      className="flex shrink-0 items-center gap-1.5 border-t border-border px-2 py-1 text-xs text-muted-foreground"
    >
      <SquareTerminal className="size-3.5 shrink-0" aria-hidden />
      <code className="min-w-0 flex-1 truncate font-mono text-foreground" title={item.command}>{item.command}</code>
      <Button
        variant="outline"
        size="xs"
        className="shrink-0"
        onClick={() => post({ t: "cancel-shell", id: sessionId, itemId: item.id })}
      >
        Cancel
      </Button>
    </div>
  );
}
