import { Button } from "@/components/ui/button";
import { GitBranchIcon, XIcon } from "lucide-react";
import type { SessionId } from "../../protocol/messages";
import { modeCanEdit } from "../../shared/side-chat-mode";
import { useStore } from "../store";

/** The strip above a side chat's transcript: what it is, whether it can edit, and the three ways out. */
export function SideChatBar({ sessionId }: { sessionId: SessionId }) {
  const { state, post } = useStore();
  const summary = state.byId[sessionId]?.summary;
  if (summary?.kind !== "side") { return null; }
  const canEdit = modeCanEdit(summary.permissionMode);

  const parent = summary.parentId ? state.sessions.find((x) => x.id === summary.parentId) : undefined;

  return (
    <div
      role="group"
      aria-label="Side chat"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-muted/30 px-2 py-1.5 text-xs"
    >
      <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="font-medium">Side chat</span>
      {parent && (
        <Button
          variant="link"
          size="xs"
          className="h-auto min-w-0 max-w-[40%] shrink justify-start truncate p-0 font-normal text-muted-foreground hover:text-foreground"
          title={`Go to ${parent.title}`}
          onClick={() => post({ t: "focus-session", id: parent.id })}
        >
          from {parent.title}
        </Button>
      )}
      {canEdit && (
        <span role="status" className="rounded-full bg-attention/15 px-2 py-0.5 font-medium text-attention">
          Can edit files
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        <Button
          size="xs"
          variant="secondary"
          title="Queue this side chat for your next message in the main chat"
          onClick={() => post({ t: "merge-side-chat", id: sessionId })}
        >
          Bring back
        </Button>
        <Button size="xs" variant="ghost" onClick={() => post({ t: "promote-side-chat", id: sessionId })}>
          Promote
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Close side chat"
          onClick={() => post({ t: "close-side-chat", id: sessionId })}
        >
          <XIcon />
        </Button>
      </div>
    </div>
  );
}
