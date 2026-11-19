import { cn } from "@/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import type { McpRow } from "../../../client-core/mcp/mcp-rows";
import type { McpRemovableOrigin } from "../../../protocol/messages";
import { McpServerRow } from "./mcp-server-row";

export type McpAction =
  | { t: "reconnect" | "sign-in"; name: string }
  | { t: "remove"; name: string; origin: McpRemovableOrigin }
  | { t: "restart" };

/** One titled run of rows; with a long list the healthy ones fold behind their header so the ones that need you stay in view. */
export function McpSection({ label, rows, collapsible, removeFrom, reconnectRestarts, signInInTerminal, onAction }: {
  label: { name: string; file?: string; title?: string };
  rows: McpRow[];
  collapsible: boolean;
  removeFrom: (row: McpRow) => string | undefined;
  reconnectRestarts: boolean;
  signInInTerminal: boolean;
  onAction: (action: McpAction) => void;
}) {
  const [folded, setFolded] = useState(true);
  // A filter or a short list never folds, whatever the user toggled before.
  const open = !collapsible || !folded;
  const title = (
    <>
      <span className="text-foreground/80">{label.name}</span>
      {label.file && <span className="font-mono"> · {label.file}</span>}
      <span className="tabular-nums"> · {rows.length}</span>
    </>
  );
  return (
    <section className="flex min-w-0 flex-col">
      {collapsible ? (
        <button
          type="button"
          aria-expanded={open}
          title={label.title}
          onClick={() => setFolded((v) => !v)}
          className="relative rounded-md pt-3 pb-1 text-left text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronRightIcon aria-hidden className={cn("absolute top-[calc(50%+0.25rem)] -left-4 size-3.5 -translate-y-1/2 transition-transform", open && "rotate-90")} />
          {title}
        </button>
      ) : (
        <h3 className="pt-3 pb-1 text-xs font-medium text-muted-foreground" title={label.title}>{title}</h3>
      )}
      {open && (
        <ul className="flex min-w-0 flex-col">
          {rows.map((row) => (
            <McpServerRow
              key={row.name}
              row={row}
              removeFrom={removeFrom(row)}
              reconnectRestarts={reconnectRestarts}
              signInInTerminal={signInInTerminal}
              onReconnect={() => onAction({ t: "reconnect", name: row.name })}
              onSignIn={() => onAction({ t: "sign-in", name: row.name })}
              onRemove={() => { if (row.removeOrigin) { onAction({ t: "remove", name: row.name, origin: row.removeOrigin }); } }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
