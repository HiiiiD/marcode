import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AlertCircleIcon, ExternalLinkIcon, MessageSquareIcon, MoreHorizontalIcon, PanelTopOpenIcon, SendIcon, SquareIcon } from "lucide-react";
import { formatElapsed } from "../../client-core/subagent-window";
import { requestTitle } from "../lib/permission-copy";
import type { SessionId, TranscriptItem } from "../../protocol/messages";
import { useStore } from "../store";

type ToolItem = Extract<TranscriptItem, { role: "tool" }>;

/** Silence this long on a running worker is worth saying out loud: it is working, or it is stuck, and the card cannot tell which. */
export const QUIET_AFTER_MS = 60_000;

export type WorkerState = "needs-you" | "quiet" | "running" | "failed" | "done";

function lastActivity(item: ToolItem): number {
  let last = item.ts;
  for (const child of item.children ?? []) { if (child.ts > last) { last = child.ts; } }
  return last;
}

/** How long a running worker has gone without doing anything; 0 when it is not running. */
export function quietFor(item: ToolItem, now: number): number {
  return item.state === "running" ? Math.max(0, now - lastActivity(item)) : 0;
}

export function workerState(item: ToolItem, blocked: boolean, now: number): WorkerState {
  if (blocked) { return "needs-you"; }
  if (item.state === "running") { return quietFor(item, now) >= QUIET_AFTER_MS ? "quiet" : "running"; }
  return item.state === "ok" ? "done" : "failed";
}

const STATUS_TONE: Record<WorkerState, string> = {
  "needs-you": "text-primary",
  quiet: "text-attention",
  running: "text-muted-foreground",
  failed: "text-destructive",
  done: "text-git-added",
};

/** The status in words, for the expanded card: the header carries it as a dot only. */
function statusWords(state: WorkerState, quietMs: number): string {
  switch (state) {
    case "needs-you": return "Needs you";
    case "quiet": return `Quiet for ${formatElapsed(quietMs)}`;
    case "running": return "Running";
    case "failed": return "Failed";
    case "done": return "Done";
  }
}

/** What a blocked worker is waiting for you to decide, in the words its own prompt uses. */
function waitingOn(item: ToolItem): string | undefined {
  for (const child of item.children ?? []) {
    if (child.role === "permission" && child.state === "pending") {
      const label = "label" in child.tool && typeof child.tool.label === "string" ? child.tool.label : "this";
      return requestTitle(child.tool, label, false);
    }
    if (child.role === "question" && child.state === "pending") { return child.questions[0]?.question ?? "A question for you"; }
  }
  return undefined;
}

/** What a hosted worker offers: stop it, message it, and the two ways to look closer. Why it failed, or what it returned, sits above. */
export function WorkerBar({ item, hostedId, state, quietMs, messaging, onToggleMessage, onOpenTranscript }: {
  item: ToolItem; hostedId: SessionId; state: WorkerState; quietMs: number; messaging: boolean; onToggleMessage: () => void; onOpenTranscript: () => void;
}) {
  const { post } = useStore();
  const running = state === "running" || state === "quiet" || state === "needs-you";
  const failed = state === "failed";
  const output = item.output?.kind === "text" ? item.output.text : undefined;
  const reason = failed ? output ?? "The worker stopped before returning a result." : undefined;

  return (
    <div className="flex flex-col gap-1.5 pb-1">
      <p className={cn("text-xs font-medium", STATUS_TONE[state])}>{statusWords(state, quietMs)}</p>
      {state === "needs-you" && (
        <p className="text-xs text-muted-foreground">{waitingOn(item) ?? "Waiting for you"}. Answer it in the prompt above the composer.</p>
      )}
      {failed && (
        <p role="alert" className="flex gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-xs wrap-break-word">
          <AlertCircleIcon aria-hidden className="mt-px size-3.5 shrink-0 text-destructive" />
          <span className="min-w-0">{reason}</span>
        </p>
      )}
      <div className="flex items-center gap-1">
        {running && (
          <Button variant="outline" size="xs" aria-label="Stop this worker" onClick={() => post({ t: "interrupt", id: hostedId })}>
            <SquareIcon aria-hidden data-icon="inline-start" className="fill-current" />
            Stop
          </Button>
        )}
        <Button variant="ghost" size="xs" aria-pressed={messaging} onClick={onToggleMessage}>
          <MessageSquareIcon aria-hidden data-icon="inline-start" />
          {running ? "Message" : "Follow up"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground" aria-label="More worker actions" />}>
            <MoreHorizontalIcon aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto">
            <DropdownMenuItem onClick={onOpenTranscript}>
              <ExternalLinkIcon aria-hidden />
              Open full transcript
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => post({ t: "promote-subagent", id: hostedId })}>
              <PanelTopOpenIcon aria-hidden />
              Open as session
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** One line to a hosted worker: the same message the other panes' composers send, addressed to its session. */
export function WorkerMessageBox({ hostedId, name, running, sent, onSent }: {
  hostedId: SessionId; name: string; running: boolean; sent: string[]; onSent: (body: string) => void;
}) {
  const { post } = useStore();
  const [text, setText] = useState("");
  const submit = () => {
    const body = text.trim();
    if (body === "") { return; }
    post({ t: "send", id: hostedId, text: body });
    onSent(body);
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
          placeholder={running ? "It reads this after its current turn" : "Starts a new turn for this worker"}
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
