import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useEffect, useRef, useState } from "react";
import type { McpScope, SessionId } from "../../../protocol/messages";
import { useStore } from "../../store";
import { McpAddForm } from "./mcp-add-form";
import { McpServerList } from "./mcp-server-list";

/** `/mcp`: this session's servers, and the one place they are added, removed and restarted. */
export function McpDialog({ id, open, onOpenChange }: { id: SessionId; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { state, post } = useStore();
  const pane = state.byId[id];
  const panel = pane?.mcpPanel;
  const [view, setView] = useState<"list" | "add">("list");
  const awaitingAdd = useRef(false);

  useEffect(() => {
    if (open) {
      setView("list");
      post({ t: "mcp-open", id });
    }
  }, [open, id, post]);

  // An add stays on the form until the host answers, so a refused write keeps what was typed.
  useEffect(() => {
    if (!awaitingAdd.current || panel === undefined) { return; }
    awaitingAdd.current = false;
    if (panel.error === undefined) { setView("list"); }
  }, [panel]);

  const servers = pane?.mcpServers ?? [];
  const takenIn = (scope: McpScope) => [
    ...servers.filter((s) => s.origin === scope).map((s) => s.name),
    ...(panel?.pending ?? []).filter((p) => p.origin === scope && p.change === "added").map((p) => p.name),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-3 overflow-y-auto text-xs">
        <DialogHeader>
          <div className="flex items-baseline justify-between gap-2 border-b border-border pr-7 pb-2">
            <DialogTitle className="text-sm">{view === "add" ? "Add MCP server" : "MCP servers"}</DialogTitle>
            <span className="truncate text-muted-foreground">{pane?.summary.name}</span>
          </div>
        </DialogHeader>
        {view === "add" && panel?.capabilities ? (
          <>
            {panel.error && <p role="alert" className="text-destructive wrap-break-word">{panel.error}</p>}
            <McpAddForm
              capabilities={panel.capabilities}
              targets={panel.targets}
              takenIn={takenIn}
              onBack={() => setView("list")}
              onSubmit={(scope, server) => {
                awaitingAdd.current = true;
                post({ t: "mcp-add", id, scope, server });
              }}
            />
          </>
        ) : (
          <McpServerList
            servers={servers}
            panel={panel}
            onAdd={() => setView("add")}
            onAction={(a) => {
              if (a.t === "restart") { post({ t: "restart-session", id }); }
              else if (a.t === "remove") { post({ t: "mcp-remove", id, name: a.name, origin: a.origin }); }
              else if (a.t === "reconnect") { post({ t: "mcp-reconnect", id, name: a.name }); }
              else { post({ t: "mcp-sign-in", id, name: a.name }); }
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
