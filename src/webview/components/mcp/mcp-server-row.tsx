import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { LogInIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import type { McpRow } from "../../../client-core/mcp/mcp-rows";

const DOT: Record<McpRow["state"], string> = {
  connected: "bg-git-added",
  failed: "bg-destructive",
  "needs-auth": "bg-git-modified",
  pending: "bg-primary/60",
  disabled: "bg-muted-foreground/40",
};

const STATE_LABEL: Record<McpRow["state"], string> = {
  connected: "Connected", failed: "Failed", "needs-auth": "Needs sign-in", pending: "Pending", disabled: "Disabled",
};

function IconAction({ label, tip, onClick, children }: {
  label: string; tip: string; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} onClick={onClick} />}>
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
  return (
    <li data-server={row.name} className="flex min-w-0 flex-col gap-1 border-t border-border py-2 first:border-t-0">
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[row.state])} />
        <span className="sr-only">{STATE_LABEL[row.state]}</span>
        <span className="min-w-0 truncate font-medium">{row.name}</span>
        {row.badge && <Badge variant="outline" className="shrink-0 px-1.5 text-[0.7rem] font-normal text-muted-foreground">{row.badge}</Badge>}
        <span className="ml-auto flex shrink-0 items-center">
          {row.canSignIn && (
            <IconAction label={`Sign in to ${row.name}`} tip="Sign in" onClick={onSignIn}><LogInIcon aria-hidden /></IconAction>
          )}
          {row.canReconnect && (
            <IconAction
              label={`Reconnect ${row.name}`}
              tip={reconnectRestarts ? "Restarts this session" : "Reconnect"}
              onClick={onReconnect}
            >
              <RefreshCwIcon aria-hidden />
            </IconAction>
          )}
          {row.canRemove && (
            <IconAction label={`Delete ${row.name}`} tip="Delete" onClick={() => setConfirming(true)}><Trash2Icon aria-hidden /></IconAction>
          )}
        </span>
      </div>
      {row.detail && (
        <p className={cn("pl-4 text-muted-foreground wrap-break-word", row.state === "failed" && "text-destructive")}>{row.detail}</p>
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
