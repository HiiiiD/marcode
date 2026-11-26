import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ArrowUpLeftIcon, BotIcon, GitBranchIcon, Maximize2Icon, Minimize2Icon, MoreHorizontalIcon, PanelTopOpenIcon, XIcon } from "lucide-react";
import type { PaneState } from "../../client-core/reducer";
import { pendingPrompts } from "../lib/pending-prompts";
import { useStore } from "../store";
import { closeSession, leafSessionIds } from "./layout-tree";
import { usePaneDensity } from "./pane-density";
import { StatusBadge } from "./status-badge";

/** Which sessions get a branch header instead of the full session header: the ones that belong to another session. */
export function isBranchPane(kind: PaneState["summary"]["kind"]): boolean {
  return kind === "side" || kind === "subagent";
}

const BRING_BACK = "Queue this side chat for your next message in the main chat";

/**
 * The header of a pane that is not a session of its own: a side chat or a subagent.
 * One row, tinted and railed in the branch colour so it never reads as "just another session", with the
 * one thing you do with it in plain view and the rest in a menu.
 */
export function BranchPaneHeader({ pane }: { pane: PaneState }) {
  const { state, post, toggleMaximize } = useStore();
  const compact = usePaneDensity() !== "comfortable";
  const s = pane.summary;
  const side = s.kind === "side";
  const parent = s.parentId ? state.sessions.find((x) => x.id === s.parentId) : undefined;
  const asksPermission = s.status === "awaiting-approval" && pendingPrompts(pane).some(({ item }) => item.role === "permission");
  const maximized = state.maximizedId === s.id;
  const canMaximize = leafSessionIds(state.layout.root).length > 1;
  const Icon = side ? GitBranchIcon : BotIcon;
  const label = side ? "Side chat" : "Subagent";

  const close = () => post(side ? { t: "close-side-chat", id: s.id } : { t: "set-layout", layout: { ...state.layout, root: closeSession(state.layout.root, s.id) } });
  const bringBack = () => post({ t: "merge-side-chat", id: s.id });
  const promote = () => post(side ? { t: "promote-side-chat", id: s.id } : { t: "promote-subagent", id: s.id });
  const toParent = () => { if (parent) { post({ t: "focus-session", id: parent.id }); } };

  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "relative flex shrink-0 items-center gap-2 overflow-hidden border-b border-border bg-branch/10 px-2 py-1 text-xs shadow-[inset_3px_0_0_var(--branch)]",
        s.status === "awaiting-approval" && (asksPermission
          ? "bg-attention/10 shadow-[inset_3px_0_0_var(--attention)]"
          : "bg-primary/10 shadow-[inset_3px_0_0_var(--primary)]"),
        s.status === "error" && "bg-destructive/10 shadow-[inset_3px_0_0_var(--destructive)]",
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0 text-branch" />
      {parent ? (
        <Button
          type="button"
          variant="bare"
          size={null}
          title={`Go to ${parent.name}`}
          onClick={toParent}
          className="min-w-0 shrink-0 cursor-pointer truncate rounded-sm font-semibold text-branch outline-none hover:underline focus-visible:underline"
        >
          {label}
        </Button>
      ) : (
        <span className="shrink-0 font-semibold text-branch">{label}</span>
      )}
      <StatusBadge status={s.status} wordFor="error" warm={asksPermission} quietIdle />
      {s.permissionMode === "bypass" && (
        <span role="status" className="shrink-0 rounded-full border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[0.7rem] font-medium text-destructive">
          Bypassing permissions
        </span>
      )}
      <span className="ml-auto" />
      {side && !compact && (
        <Button size="xs" variant="secondary" title={BRING_BACK} onClick={bringBack}>Bring back</Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="shrink-0" aria-label={`${label} actions`} />}>
          <MoreHorizontalIcon aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto">
          {side && compact && (
            <DropdownMenuItem title={BRING_BACK} onClick={bringBack}>
              <ArrowUpLeftIcon aria-hidden />
              Bring back to the main chat
            </DropdownMenuItem>
          )}
          {parent && (
            <DropdownMenuItem onClick={toParent}>
              <ArrowUpLeftIcon aria-hidden />
              Go to {parent.name}
            </DropdownMenuItem>
          )}
          {canMaximize && (
            <DropdownMenuItem onClick={() => toggleMaximize(s.id)}>
              {maximized ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
              {maximized ? "Restore split" : "Maximize pane"}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem title="Keep this as a normal session, no longer tied to its parent" onClick={promote}>
            <PanelTopOpenIcon aria-hidden />
            Promote to a full session
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="icon-xs" className="shrink-0" aria-label={side ? "Close side chat" : "Close subagent"} onClick={close}>
        <XIcon aria-hidden />
      </Button>
    </div>
  );
}
