import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertCircleIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useState } from "react";
import { groupRows, mcpRows, mcpSummary, type McpRow } from "../../../client-core/mcp/mcp-rows";
import type { McpPanel, McpRemovableOrigin, McpServerStatus } from "../../../protocol/messages";
import { McpSection, type McpAction } from "./mcp-section";

/** Past this many servers a filter appears and healthy ones start collapsed: the list is for finding the one that needs you. */
const FILTER_ABOVE = 8;
const COLLAPSE_ABOVE = 12;

const NEEDS_YOU = new Set<McpRow["state"]>(["failed", "needs-auth", "pending"]);

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

/** The body scrolls inside the dialog's frame; what needs an answer (restart, a failed write) sits in the footer so the list never moves. */
export function McpServerList({ servers, panel, onAction, onAdd }: {
  servers: McpServerStatus[];
  panel: McpPanel | undefined;
  onAction: (action: McpAction) => void;
  onAdd: () => void;
}) {
  const [query, setQuery] = useState("");
  const all = mcpRows(servers, panel);
  const canManage = Boolean(panel?.capabilities);
  const pending = panel?.pending.length ?? 0;
  const empty = all.length === 0;
  const q = query.trim().toLowerCase();
  const rows = q ? all.filter((r) => r.name.toLowerCase().includes(q)) : all;
  const attention = rows.filter((r) => NEEDS_YOU.has(r.state));
  const healthy = rows.filter((r) => !NEEDS_YOU.has(r.state));
  const collapsible = all.length > COLLAPSE_ABOVE && q === "";

  const shared = {
    removeFrom: (row: McpRow) => fileFor(panel, row.removeOrigin),
    reconnectRestarts: panel?.capabilities?.reconnect === "restart",
    signInInTerminal: canManage && panel?.capabilities?.signIn === false,
    onAction,
  };

  return (
    <>
      {all.length > FILTER_ABOVE && (
        <div className="relative shrink-0">
          <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Filter servers" placeholder="Filter servers" className="h-8 pl-8" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}
      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
        {panel !== undefined && !canManage && (
          <p className="text-pretty text-xs text-muted-foreground">{panel.readOnly ?? "This provider can't manage MCP servers from Marcode."}</p>
        )}
        {empty ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">No MCP servers yet.</p>
              <p className="text-pretty text-muted-foreground">Servers give the agent extra tools, like GitHub or a database.</p>
            </div>
            {canManage && (
              <Button size="sm" variant="secondary" onClick={onAdd}>
                <PlusIcon aria-hidden data-icon="inline-start" />
                Add server
              </Button>
            )}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground">No server matches “{query.trim()}”.</p>
        ) : (
          <>
            {attention.length > 0 && <McpSection label={{ name: "Needs attention" }} rows={attention} collapsible={false} {...shared} />}
            {groupRows(healthy).map((group) => (
              <McpSection key={group.key} label={sectionLabel(group.key, panel)} rows={group.rows} collapsible={collapsible} {...shared} />
            ))}
          </>
        )}
      </div>
      {(panel?.error || pending > 0 || !empty || !canManage) && (
        <div className="flex shrink-0 flex-col gap-2 border-t border-border pt-3">
          {panel?.error && <p role="alert" className="flex gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-xs wrap-break-word"><AlertCircleIcon aria-hidden className="mt-px size-3.5 shrink-0 text-destructive" />{panel.error}</p>}
          <div className="flex items-center justify-between gap-3">
            {pending > 0 ? (
              <span role="status" className="flex min-w-0 items-center gap-2">
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-attention" />
                <span className="truncate">Config changed. Restart to load it.</span>
              </span>
            ) : (
              <span className="text-xs text-muted-foreground tabular-nums">{mcpSummary(all)}</span>
            )}
            <span className="flex shrink-0 items-center gap-2">
              {canManage && (
                <Button size="sm" variant="secondary" onClick={onAdd}>
                  <PlusIcon aria-hidden data-icon="inline-start" />
                  Add server
                </Button>
              )}
              {pending > 0 && (
                <Button size="sm" disabled={panel?.restarting} onClick={() => onAction({ t: "restart" })}>
                  {panel?.restarting ? "Restarting…" : "Restart session"}
                </Button>
              )}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
