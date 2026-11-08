import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";
import type { SessionId } from "../../protocol/messages";
import { modeCanEdit } from "../../shared/side-chat-mode";
import { useStore } from "../store";

/** The strip above a side chat's transcript: what it is, whether it can edit, and the three ways out. */
export function SideChatBar({ sessionId }: { sessionId: SessionId }) {
  const { state, post } = useStore();
  const summary = state.byId[sessionId]?.summary;
  if (summary?.kind !== "side") { return null; }
  const canEdit = modeCanEdit(summary.permissionMode);

  return (
    <div
      role="group"
      aria-label="Side chat"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-muted/40 px-2 py-1 text-xs"
    >
      <span className="font-medium">Side chat</span>
      {canEdit && (
        <Badge variant="outline" role="status" className="border-destructive/60 text-destructive">
          Can edit files
        </Badge>
      )}
      <div className="ml-auto flex items-center gap-1">
        <Button
          size="xs"
          variant="ghost"
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
