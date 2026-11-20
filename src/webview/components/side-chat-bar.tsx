import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ArrowUpLeftIcon, GitBranchIcon, MoreHorizontalIcon, PanelTopOpenIcon } from "lucide-react";
import type { SessionId } from "../../protocol/messages";
import { modeCanEdit } from "../../shared/side-chat-mode";
import { useStore } from "../store";
import { usePaneDensity } from "./pane-density";

const BRING_BACK = "Queue this side chat for your next message in the main chat";
const PROMOTE = "Keep this as a normal session, no longer tied to the main chat";

/** The strip above a side chat's transcript: what it is, where it came from, whether it can edit, and what to do with it. Closing is the header's ✕. */
export function SideChatBar({ sessionId }: { sessionId: SessionId }) {
  const { state, post } = useStore();
  const density = usePaneDensity();
  const summary = state.byId[sessionId]?.summary;
  if (summary?.kind !== "side") { return null; }
  const canEdit = modeCanEdit(summary.permissionMode);
  const parent = summary.parentId ? state.sessions.find((x) => x.id === summary.parentId) : undefined;
  const bringBack = () => post({ t: "merge-side-chat", id: sessionId });
  const promote = () => post({ t: "promote-side-chat", id: sessionId });

  return (
    <div
      role="group"
      aria-label="Side chat"
      className="flex items-center gap-x-2 border-b border-border bg-muted/30 px-2 py-1.5 text-xs"
    >
      <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 items-baseline gap-1">
        <span className="shrink-0 font-medium">Side chat</span>
        {parent && (
          <Button
            variant="link"
            size="xs"
            className="h-auto min-w-0 justify-start truncate p-0 font-normal text-muted-foreground hover:text-foreground"
            title={`Go to ${parent.name}`}
            onClick={() => post({ t: "focus-session", id: parent.id })}
          >
            of {parent.name}
          </Button>
        )}
      </span>
      {canEdit && (
        <span role="status" className="shrink-0 rounded-full bg-attention/15 px-2 py-0.5 font-medium text-attention">
          Can edit files
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {density === "comfortable" ? (
          <>
            <Button size="xs" variant="secondary" title={BRING_BACK} onClick={bringBack}>Bring back</Button>
            <Button size="xs" variant="ghost" title={PROMOTE} onClick={promote}>Promote</Button>
          </>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label="Side chat actions" />}>
              <MoreHorizontalIcon aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto">
              <DropdownMenuItem title={BRING_BACK} onClick={bringBack}>
                <ArrowUpLeftIcon aria-hidden />
                Bring back to the main chat
              </DropdownMenuItem>
              <DropdownMenuItem title={PROMOTE} onClick={promote}>
                <PanelTopOpenIcon aria-hidden />
                Promote to a full session
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
