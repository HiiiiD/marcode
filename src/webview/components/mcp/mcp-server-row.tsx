import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import type { McpRow } from "../../../client-core/mcp/mcp-rows";

const DOT: Record<McpRow["state"], string> = {
  connected: "bg-git-added",
  failed: "bg-destructive",
  "needs-auth": "bg-attention",
  pending: "bg-muted-foreground/60 motion-safe:animate-pulse",
  disabled: "border border-muted-foreground/60",
};

const STATE_LABEL: Record<McpRow["state"], string> = {
  connected: "Connected", failed: "Failed", "needs-auth": "Needs sign-in", pending: "Pending", disabled: "Disabled",
};

const LONG_ERROR = 70;

function IconAction({ label, tip, onClick, disabled, children }: {
  label: string; tip: string; onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} disabled={disabled} onClick={onClick} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

export function McpServerRow({ row, removeFrom, reconnectRestarts, onReconnect, onRemove, onSignIn }: {
  row: McpRow;
  /** The file Delete will change, named in the confirmation. */
  removeFrom: string | undefined;
  reconnectRestarts: boolean;
  onReconnect: () => void;
  onRemove: () => void;
  onSignIn: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const failed = row.state === "failed";
  const longError = failed && row.detail.length > LONG_ERROR;
  // A failure gets its own line below the name; everything else is a quiet fact beside it.
  const meta = [row.badge, failed ? "" : row.detail].filter(Boolean).join(" · ");
  return (
    <li data-server={row.name} className="group/row flex min-w-0 flex-col gap-0.5 py-1.5">
      <div className="flex min-h-6 min-w-0 items-center gap-2">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[row.state])} />
        <span className="sr-only">{STATE_LABEL[row.state]}</span>
        <span className="min-w-0 truncate font-medium">{row.name}</span>
        {meta && <span className="min-w-0 shrink-[3] truncate text-muted-foreground">{meta}</span>}
        <span className="ml-auto flex shrink-0 items-center">
          {row.canSignIn && (
            <Button variant="outline" size="xs" aria-label={`Sign in to ${row.name}`} onClick={onSignIn}>Sign in</Button>
          )}
          <span className="flex items-center opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
            {(row.canReconnect || row.busy) && (
              <IconAction
                label={`Reconnect ${row.name}`}
                tip={row.busy ? "Restarting…" : reconnectRestarts ? "Restarts this session" : "Reconnect"}
                disabled={row.busy}
                onClick={onReconnect}
              >
                <RefreshCwIcon aria-hidden />
              </IconAction>
            )}
            {row.canRemove && (
              <IconAction label={`Delete ${row.name}`} tip="Delete" onClick={() => setConfirming(true)}><Trash2Icon aria-hidden /></IconAction>
            )}
          </span>
        </span>
      </div>
      {failed && row.detail && (
        <div className="flex min-w-0 items-baseline gap-2 pl-4">
          <p className={cn("min-w-0 flex-1 text-destructive", expanded ? "font-mono wrap-break-word" : "truncate")}>{row.detail}</p>
          {longError && (
            <Button variant="link" size="xs" className="h-auto shrink-0 p-0 text-muted-foreground" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Less" : "Details"}
            </Button>
          )}
        </div>
      )}
      {confirming && (
        <div className="ml-4 flex flex-col gap-1.5 rounded-md bg-muted px-2 py-1.5">
          <p className="wrap-break-word">Delete {row.name} from {removeFrom ?? "its config file"}?</p>
          <div className="flex justify-end gap-1">
            <Button variant="ghost" size="xs" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="destructive" size="xs" onClick={() => { setConfirming(false); onRemove(); }}>Delete</Button>
          </div>
        </div>
      )}
    </li>
  );
}
