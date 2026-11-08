import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { childrenRows } from "../../client-core/children-rows";
import type { SessionId } from "../../protocol/messages";
import { useStore } from "../store";
import { StatusBadge } from "./status-badge";

/** Where this session came from and the forks and side chats branched off it. */
export function ChildrenList({ sessionId }: { sessionId: SessionId }) {
  const { state, post } = useStore();
  const [open, setOpen] = useState(false);
  const summary = state.byId[sessionId]?.summary;
  const rows = childrenRows(summary?.children);
  const parent = summary?.parentId ? state.sessions.find((s) => s.id === summary.parentId) : undefined;
  if (!summary || (rows.length === 0 && !summary.parentId)) { return null; }

  return (
    <div className="border-b border-border text-xs">
      {summary.parentId && (parent ? (
        <Button
          variant="link"
          size="xs"
          className="max-w-full justify-start truncate px-2"
          onClick={() => post({ t: "focus-session", id: parent.id })}
        >
          Branched from {parent.title}
        </Button>
      ) : (
        <p className="px-2 py-1 text-muted-foreground">Branched from a deleted chat</p>
      ))}
      {rows.length > 0 && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger
            render={<Button variant="ghost" size="xs" className="w-full justify-start gap-1 px-2 font-normal" />}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-90")}
            />
            {rows.length} {rows.length === 1 ? "fork or side chat" : "forks and side chats"}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="flex flex-col pb-1">
              {rows.map((row) => (
                <li key={row.id}>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="w-full justify-start gap-2 px-2 font-normal"
                    onClick={() => post({ t: "focus-session", id: row.id })}
                  >
                    <span className="min-w-0 flex-1 truncate text-left">{row.title}</span>
                    <StatusBadge status={row.status} hideIdle />
                    <Badge variant="outline" className="shrink-0">{row.badge}</Badge>
                  </Button>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
