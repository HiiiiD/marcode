import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { CopyIcon, MoreHorizontalIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { McpRow } from "../../../client-core/mcp/mcp-rows";

const DOT: Record<McpRow["state"], string> = {
  connected: "bg-git-added",
  failed: "bg-destructive",
  "needs-auth": "bg-attention",
  pending: "bg-muted-foreground motion-safe:animate-pulse",
  disabled: "bg-muted-foreground/50",
};

const STATE_LABEL: Record<McpRow["state"], string> = {
  connected: "Connected", failed: "Failed", "needs-auth": "Needs sign-in", pending: "Connecting", disabled: "Disabled",
};

/** The quiet second line: what state it is in, and for a healthy server how many tools it brings. */
function subtitle(row: McpRow): string {
  if (row.state === "connected") { return row.detail || STATE_LABEL.connected; }
  if (row.state === "pending") { return row.detail || STATE_LABEL.pending; }
  return STATE_LABEL[row.state];
}

/** A failed row's left side opens its error; any other row's is plain. */
function Lead({ failed, expanded, onToggle, children }: { failed: boolean; expanded: boolean; onToggle: () => void; children: React.ReactNode }) {
  const cls = "flex h-full min-w-0 flex-1 items-center gap-2.5";
  if (!failed) { return <div className={cls}>{children}</div>; }
  return (
    <button type="button" aria-expanded={expanded} title={expanded ? "Hide the error" : "Show the error"} onClick={onToggle} className={cn(cls, "cursor-pointer text-left outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-md")}>
      {children}
    </button>
  );
}

export function McpServerRow({ row, removeFrom, reconnectRestarts, signInInTerminal, onReconnect, onRemove, onSignIn }: {
  row: McpRow;
  /** The file Delete will change, named in the confirmation. */
  removeFrom: string | undefined;
  reconnectRestarts: boolean;
  /** The provider cannot start this sign-in itself, so the button opens its own CLI in a terminal. */
  signInInTerminal: boolean;
  onReconnect: () => void;
  onRemove: () => void;
  onSignIn: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const failed = row.state === "failed";
  const hasMenu = row.canReconnect || row.canRemove || failed;
  return (
    <li data-server={row.name} className="group/row -mx-2 flex min-w-0 flex-col rounded-lg px-2 transition-colors hover:bg-muted/30">
      <div className="flex h-9 min-w-0 items-center gap-2.5">
        <Lead
          failed={failed && Boolean(row.detail)}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
        >
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[row.state])} />
          <span className="sr-only">{STATE_LABEL[row.state]}</span>
          <span className="min-w-0 truncate">{row.name}</span>
          {row.private && <span className="shrink-0 text-xs text-muted-foreground">private</span>}
          <span className={cn("ml-auto shrink-0 truncate text-xs", failed ? "text-destructive" : "text-muted-foreground")}>{subtitle(row)}</span>
        </Lead>
        {row.busy ? (
          <Button variant="ghost" size="xs" disabled aria-label={`Reconnect ${row.name}`}>
            <RefreshCwIcon aria-hidden data-icon="inline-start" className="motion-safe:animate-spin" />
            Reconnect
          </Button>
        ) : failed && row.canReconnect ? (
          <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground" aria-label={`Reconnect ${row.name}`} title={reconnectRestarts ? "Restarts this session" : undefined} onClick={onReconnect}>
            <RefreshCwIcon aria-hidden data-icon="inline-start" />
            Reconnect
          </Button>
        ) : row.canSignIn || (row.state === "needs-auth" && signInInTerminal) ? (
          <Button variant="ghost" size="xs" className="text-primary hover:text-primary" aria-label={`Sign in to ${row.name}`} title={row.canSignIn ? undefined : "Opens the provider's CLI in a terminal"} onClick={onSignIn}>Sign in</Button>
        ) : null}
        {hasMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 aria-expanded:opacity-100" aria-label={`More actions for ${row.name}`} />}>
              <MoreHorizontalIcon aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-40">
              {row.canReconnect && !failed && (
                <DropdownMenuItem disabled={row.busy} onClick={onReconnect}>
                  <RefreshCwIcon aria-hidden />
                  {reconnectRestarts ? "Reconnect (restarts session)" : "Reconnect"}
                </DropdownMenuItem>
              )}
              {failed && row.detail && (
                <DropdownMenuItem onClick={() => { void navigator.clipboard.writeText(row.detail).then(() => toast("Error copied")); }}>
                  <CopyIcon aria-hidden />
                  Copy error
                </DropdownMenuItem>
              )}
              {row.canRemove && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
                    <Trash2Icon aria-hidden />
                    Delete…
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : <span className="size-6 shrink-0" aria-hidden />}
      </div>
      {failed && row.detail && expanded && (
        <p className="mb-2 ml-[1.125rem] rounded-md bg-destructive/10 px-2.5 py-1.5 font-mono text-xs text-foreground/80 wrap-break-word">{row.detail}</p>
      )}
      {row.state === "needs-auth" && !row.canSignIn && !signInInTerminal && !row.busy && (
        <p className="mb-2 ml-[1.125rem] text-pretty text-muted-foreground">This provider can't sign in to servers from here.</p>
      )}
      {confirming && (
        <div className="mb-2 ml-[1.125rem] flex flex-col gap-1.5 rounded-lg bg-muted px-3 py-2">
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
