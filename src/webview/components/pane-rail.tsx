import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PaneState } from "../reducer";
import { useStore } from "../store";
import { displayStatus } from "../../client-core/display-status";
import { StatusBadge } from "./status-badge";

/**
 * What a pane becomes when something else is maximized and it is squeezed to a
 * thin column: its status and its name, set upright, and nothing else. The
 * whole rail is the control — one click brings that session to the front — so
 * the few pixels it has left are spent on telling sessions apart, not on
 * buttons.
 */
export function PaneRail({ pane }: { pane: PaneState }) {
  const { toggleMaximize } = useStore();
  const s = pane.summary;
  const status = displayStatus(s);
  const needsYou = status === "awaiting-approval";

  return (
    <Button
      type="button"
      variant="bare"
      size={null}
      aria-label={`Show ${s.name}`}
      title={s.name}
      onClick={() => toggleMaximize(s.id)}
      className={cn(
        "flex h-full w-full min-w-0 flex-col items-center justify-start gap-2 px-1 py-2 text-xs",
        "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        needsYou && "bg-primary/10 shadow-[inset_0_3px_0_var(--primary)]",
      )}
    >
      <StatusBadge status={status} quietIdle compact />
      <span className="min-h-0 flex-1 truncate font-medium [text-orientation:mixed] [writing-mode:vertical-rl]">{s.name}</span>
    </Button>
  );
}
