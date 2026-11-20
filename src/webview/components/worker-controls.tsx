import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AlertCircleIcon, SendIcon, SquareIcon } from "lucide-react";
import { formatElapsed } from "../../client-core/subagent-window";
import type { SessionId, TranscriptItem } from "../../protocol/messages";
import { useStore } from "../store";

type ToolItem = Extract<TranscriptItem, { role: "tool" }>;

/** Silence this long on a running worker is worth saying out loud: it is working, or it is stuck, and the card cannot tell which. */
const QUIET_AFTER_MS = 60_000;

function lastActivity(item: ToolItem): number {
  let last = item.ts;
  for (const child of item.children ?? []) { if (child.ts > last) { last = child.ts; } }
  return last;
}

/** What a hosted worker is doing right now, why it failed if it did, and the way to stop it. */
export function WorkerStatus({ item, hostedId, now, elapsedMs, blocked }: {
  item: ToolItem; hostedId: SessionId; now: number; elapsedMs: number; blocked: boolean;
}) {
  const { post } = useStore();
  const running = item.state === "running";
  const failed = item.state !== "running" && item.state !== "ok";
  const quietMs = running ? now - lastActivity(item) : 0;
  const reason = failed && item.output?.kind === "text" ? item.output.text : undefined;
  const word = blocked ? "Needs you" : running ? "Running" : failed ? "Failed" : "Done";

  return (
    <div className="flex flex-col gap-1.5 pb-1">
      <div className="flex items-center gap-2 text-xs">
        <span className={cn("font-medium", failed && "text-destructive", blocked && "text-primary")}>{word}</span>
        <span className="text-muted-foreground tabular-nums">{formatElapsed(elapsedMs)}</span>
        {running && quietMs >= QUIET_AFTER_MS && (
          <span className="rounded-full bg-attention/15 px-2 py-0.5 text-attention tabular-nums">
            no activity {formatElapsed(quietMs)}
          </span>
        )}
        {running && (
          <Button
            variant="outline"
            size="xs"
            className="ml-auto"
            aria-label="Stop this worker"
            onClick={() => post({ t: "interrupt", id: hostedId })}
          >
            <SquareIcon aria-hidden data-icon="inline-start" className="fill-current" />
            Stop
          </Button>
        )}
      </div>
      {failed && (
        <p role="alert" className="flex gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-xs wrap-break-word">
          <AlertCircleIcon aria-hidden className="mt-px size-3.5 shrink-0 text-destructive" />
          <span className="min-w-0">{reason ?? "The worker stopped before returning a result."}</span>
        </p>
      )}
    </div>
  );
}

/** One line to a hosted worker: the same message the other panes' composers send, addressed to its session. */
export function WorkerMessageBox({ hostedId, name, running }: { hostedId: SessionId; name: string; running: boolean }) {
  const { post } = useStore();
  const [text, setText] = useState("");
  const [sent, setSent] = useState<string[]>([]);
  const submit = () => {
    const body = text.trim();
    if (body === "") { return; }
    post({ t: "send", id: hostedId, text: body });
    setSent((prev) => [...prev, body]);
    setText("");
  };

  return (
    <form className="flex flex-col gap-1 pt-1" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {sent.map((body, i) => (
        <p key={i} className="rounded-md bg-muted px-2 py-1 text-xs wrap-break-word">
          <span className="text-muted-foreground">You to {name}: </span>{body}
        </p>
      ))}
      <div className="flex items-center gap-1">
        <Input
          aria-label={`Message ${name}`}
          className="h-7 min-w-0 flex-1 text-xs"
          placeholder={running ? `Message ${name}. It reads it after its current turn.` : `Message ${name}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" variant="ghost" size="icon-xs" aria-label={`Send to ${name}`} disabled={text.trim() === ""}>
          <SendIcon aria-hidden />
        </Button>
      </div>
    </form>
  );
}
