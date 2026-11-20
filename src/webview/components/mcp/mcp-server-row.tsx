import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { AlertCircleIcon, CopyIcon, MoreHorizontalIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { McpRow } from "../../../client-core/mcp/mcp-rows";

const PILL: Record<McpRow["state"], string> = {
  connected: "bg-git-added/15 text-git-added",
  failed: "bg-destructive/15 text-destructive",
  "needs-auth": "bg-attention/15 text-attention",
  pending: "bg-primary/15 text-primary",
  disabled: "bg-foreground/10 text-muted-foreground",
};

const CARD: Record<McpRow["state"], string> = {
  connected: "border-border",
  failed: "border-destructive/40 bg-destructive/5",
  "needs-auth": "border-attention/40",
  pending: "border-border",
  disabled: "border-border opacity-70",
};

const STATE_LABEL: Record<McpRow["state"], string> = {
  connected: "Connected", failed: "Failed", "needs-auth": "Needs sign-in", pending: "Connecting", disabled: "Disabled",
};

function StatusPill({ state }: { state: McpRow["state"] }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", PILL[state])}>
      <span aria-hidden className={cn("size-1.5 rounded-full bg-current", state === "pending" && "motion-safe:animate-pulse")} />
      {STATE_LABEL[state]}
    </span>
  );
}

/** One server as a card: name and state on top, one line of what it offers, then where it lives and what you can do. */
export function McpServerRow({ row, source, removeFrom, reconnectRestarts, signInInTerminal, onReconnect, onRemove, onSignIn }: {
  row: McpRow;
  /** Which config it comes from, shown when its section does not already say so. */
  source?: string;
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
  const canSignIn = row.canSignIn || (row.state === "needs-auth" && signInInTerminal && !row.busy);
  const hasMenu = row.canReconnect || row.canRemove || failed;
  const [count, ...unit] = row.detail.split(" ");

  const menu = hasMenu && (
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={`More actions for ${row.name}`} />}>
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
  );
  const primary = row.busy || (failed && row.canReconnect) || canSignIn;
  const footer = Boolean(source || row.private || primary);

  let hint: React.ReactNode = null;
  if (row.state === "connected") {
    hint = row.detail ? <><span className="text-sm font-medium text-foreground tabular-nums">{count}</span> {unit.join(" ")}</> : "Ready";
  } else if (failed && row.detail) {
    hint = (
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)} className="cursor-pointer text-destructive underline-offset-2 outline-none hover:underline focus-visible:underline">
        {expanded ? "Hide error" : "Show error"}
      </button>
    );
  } else if (row.state === "needs-auth") {
    hint = canSignIn ? "Sign in to use its tools" : "This provider can't sign in to servers from here.";
  } else if (row.state === "disabled") {
    hint = "Turned off in its config";
  } else if (row.detail) {
    hint = row.detail;
  }

  return (
    <li data-server={row.name} className={cn("flex min-w-0 flex-col gap-2 rounded-lg border bg-foreground/[0.03] p-3", CARD[row.state])}>
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate font-medium">{row.name}</span>
        <span className="sr-only">{STATE_LABEL[row.state]}</span>
        <StatusPill state={row.state} />
      </div>
      {(hint || !footer) && (
        <div className="flex min-h-6 items-center justify-between gap-2">
          <p className="min-w-0 text-xs text-muted-foreground">{hint}</p>
          {!footer && menu}
        </div>
      )}
      {failed && expanded && row.detail && (
        <p className="flex gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-foreground/85 wrap-break-word">
          <AlertCircleIcon aria-hidden className="mt-px size-3.5 shrink-0 text-destructive" />
          <span className="min-w-0 font-mono">{row.detail}</span>
        </p>
      )}
      {confirming ? (
        <div className="flex flex-col gap-1.5 rounded-md bg-muted px-3 py-2">
          <p className="wrap-break-word">Delete {row.name} from {removeFrom ?? "its config file"}?</p>
          <div className="flex justify-end gap-1">
            <Button variant="ghost" size="xs" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="destructive" size="xs" onClick={() => { setConfirming(false); onRemove(); }}>Delete</Button>
          </div>
        </div>
      ) : footer && (
        <div className="mt-auto flex min-h-6 items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {source && <span className="font-mono">{source}</span>}
            {row.private && <span>{source ? " · " : ""}private</span>}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {row.busy ? (
              <Button variant="secondary" size="xs" disabled aria-label={`Reconnect ${row.name}`}>
                <RefreshCwIcon aria-hidden data-icon="inline-start" className="motion-safe:animate-spin" />
                Reconnect
              </Button>
            ) : failed && row.canReconnect ? (
              <Button variant="secondary" size="xs" aria-label={`Reconnect ${row.name}`} title={reconnectRestarts ? "Restarts this session" : undefined} onClick={onReconnect}>
                <RefreshCwIcon aria-hidden data-icon="inline-start" />
                Reconnect
              </Button>
            ) : canSignIn ? (
              <Button size="xs" aria-label={`Sign in to ${row.name}`} title={row.canSignIn ? undefined : "Opens the provider's CLI in a terminal"} onClick={onSignIn}>Sign in</Button>
            ) : null}
            {menu}
          </span>
        </div>
      )}
    </li>
  );
}
