import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { shellCard } from "../../client-core/shell-card";
import type { SessionId, ShellItem } from "../../protocol/messages";
import { useStore } from "../store";
import { TranscriptItemShell } from "./transcript-item-shell";

export function ShellCard({ item, sessionId }: { item: ShellItem; sessionId: SessionId }) {
  const { post } = useStore();
  const card = shellCard(item);
  return (
    <TranscriptItemShell role="tool" label="Shell" ts={item.ts}>
      <div className="flex min-w-0 flex-col gap-1">
        <code className="truncate font-mono text-xs text-foreground" title={card.command}>{card.command}</code>
        {card.output.trim() === "" ? null : (
          <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre text-muted-foreground">
            {card.output}
          </pre>
        )}
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className={cn("min-w-0 wrap-break-word text-muted-foreground", card.failed && "text-destructive")}>
            {card.footer}
          </span>
          {card.running ? (
            <Button
              variant="outline"
              size="xs"
              className="shrink-0"
              onClick={() => post({ t: "cancel-shell", id: sessionId, itemId: item.id })}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </div>
    </TranscriptItemShell>
  );
}
