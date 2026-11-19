import { Button } from "@/components/ui/button";
import { PlusIcon } from "lucide-react";
import { groupRows, mcpRows, mcpSummary } from "../../../client-core/mcp/mcp-rows";
import type { McpPanel, McpRemovableOrigin, McpServerStatus } from "../../../protocol/messages";
import { McpServerRow } from "./mcp-server-row";

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function sectionLabel(key: string, panel: McpPanel | undefined): { name: string; file?: string; title?: string } {
  const scope = key === "repo" || key === "global" ? key : undefined;
  const target = scope ? panel?.targets?.[scope] : undefined;
  const name = key.charAt(0).toUpperCase() + key.slice(1);
  return target && "path" in target ? { name, file: basename(target.path), title: target.path } : { name };
}

function fileFor(panel: McpPanel | undefined, origin: McpRemovableOrigin | undefined): string | undefined {
  const targets = panel?.targets;
  if (!targets || !origin) { return undefined; }
  const target = origin === "repo" ? targets.repo : targets.global;
  if (!("path" in target)) { return undefined; }
  return origin === "repo-private" ? `${target.path} (this repo)` : target.path;
}

/** The body scrolls inside the dialog's fixed frame; what needs an answer (restart, a failed write) sits in the footer so the list never moves. */
export function McpServerList({ servers, panel, onAction, onAdd }: {
  servers: McpServerStatus[];
  panel: McpPanel | undefined;
  onAction: (action: { t: "reconnect" | "sign-in"; name: string } | { t: "remove"; name: string; origin: McpRemovableOrigin } | { t: "restart" }) => void;
  onAdd: () => void;
}) {
  const rows = mcpRows(servers, panel);
  const canManage = Boolean(panel?.capabilities);
  const pending = panel?.pending.length ?? 0;
  const empty = rows.length === 0;
  return (
    <>
      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
        {panel !== undefined && !canManage && (
          <p className="text-pretty text-muted-foreground">{panel.readOnly ?? "This provider can't manage MCP servers from Marcode."}</p>
        )}
        {empty ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">No MCP servers yet.</p>
              <p className="text-pretty text-muted-foreground">Servers give the agent extra tools, like GitHub or a database.</p>
            </div>
            {canManage && (
              <Button size="sm" onClick={onAdd}>
                <PlusIcon aria-hidden data-icon="inline-start" />
                Add server
              </Button>
            )}
          </div>
        ) : (
          groupRows(rows).map((group) => {
            const label = sectionLabel(group.key, panel);
            return (
              <section key={group.key} className="flex min-w-0 flex-col">
                <h3 className="pt-3 pb-1 text-xs font-medium text-muted-foreground" title={label.title}>
                  {label.name}
                  {label.file && <span className="font-mono"> · {label.file}</span>}
                </h3>
                <ul className="flex min-w-0 flex-col">
                  {group.rows.map((row) => (
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
              </section>
            );
          })
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-border pt-3">
        {panel?.error && <p role="alert" className="text-destructive wrap-break-word">{panel.error}</p>}
        {pending > 0 ? (
          <div role="status" className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-attention" />
              <span className="truncate">Config changed. Restart to load it.</span>
            </span>
            <Button size="sm" disabled={panel?.restarting} onClick={() => onAction({ t: "restart" })}>
              {panel?.restarting ? "Restarting…" : "Restart session"}
            </Button>
          </div>
        ) : (!empty || !canManage) && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground tabular-nums">{mcpSummary(rows)}</span>
            {canManage && (
              <Button size="sm" variant="outline" onClick={onAdd}>
                <PlusIcon aria-hidden data-icon="inline-start" />
                Add server
              </Button>
            )}
          </div>
        )}
        {pending > 0 && canManage && (
          <Button size="sm" variant="ghost" className="self-start text-muted-foreground" onClick={onAdd}>
            <PlusIcon aria-hidden data-icon="inline-start" />
            Add server
          </Button>
        )}
      </div>
    </>
  );
}
