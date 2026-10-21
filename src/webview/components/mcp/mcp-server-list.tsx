import { Button } from "@/components/ui/button";
import { PlusIcon } from "lucide-react";
import { mcpRows, mcpSummary } from "../../../client-core/mcp/mcp-rows";
import type { McpPanel, McpRemovableOrigin, McpServerStatus } from "../../../protocol/messages";
import { McpServerRow } from "./mcp-server-row";

function fileFor(panel: McpPanel | undefined, origin: McpRemovableOrigin | undefined): string | undefined {
  const targets = panel?.targets;
  if (!targets || !origin) { return undefined; }
  const target = origin === "repo" ? targets.repo : targets.global;
  if (!("path" in target)) { return undefined; }
  return origin === "repo-private" ? `${target.path} (this repo)` : target.path;
}

export function McpServerList({ servers, panel, onAction, onAdd }: {
  servers: McpServerStatus[];
  panel: McpPanel | undefined;
  onAction: (action: { t: "reconnect" | "sign-in"; name: string } | { t: "remove"; name: string; origin: McpRemovableOrigin } | { t: "restart" }) => void;
  onAdd: () => void;
}) {
  const rows = mcpRows(servers, panel);
  const canManage = Boolean(panel?.capabilities);
  const pending = panel?.pending.length ?? 0;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {pending > 0 && (
        <div role="status" className="flex items-center justify-between gap-2 rounded-md bg-muted px-2 py-1.5">
          <span>Config changed. Restart to load it.</span>
          <Button size="xs" disabled={panel?.restarting} onClick={() => onAction({ t: "restart" })}>
            {panel?.restarting ? "Restarting…" : "Restart session"}
          </Button>
        </div>
      )}
      {panel?.error && <p role="alert" className="text-destructive wrap-break-word">{panel.error}</p>}
      {panel !== undefined && !canManage && (
        <p className="text-muted-foreground">This provider can&apos;t manage MCP servers from Marcode.</p>
      )}
      {rows.length === 0 ? (
        <p className="py-2 text-muted-foreground">No MCP servers yet.</p>
      ) : (
        <ul className="flex min-w-0 flex-col">
          {rows.map((row) => (
            <McpServerRow
              key={row.name}
              row={row}
              removeFrom={fileFor(panel, row.removeOrigin)}
              reconnectRestarts={panel?.capabilities?.reconnect === "restart"}
              onReconnect={() => onAction({ t: "reconnect", name: row.name })}
              onSignIn={() => onAction({ t: "sign-in", name: row.name })}
              onRemove={() => { if (row.removeOrigin) { onAction({ t: "remove", name: row.name, origin: row.removeOrigin }); } }}
            />
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
        <span className="text-muted-foreground tabular-nums">{mcpSummary(rows)}</span>
        {canManage && (
          <Button size="xs" variant="outline" onClick={onAdd}>
            <PlusIcon aria-hidden data-icon="inline-start" />
            Add server
          </Button>
        )}
      </div>
    </div>
  );
}
