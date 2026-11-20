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

export const STATUS_TONE: Record<WorkerState, string> = {
  "needs-you": "text-primary",
  quiet: "text-attention",
  running: "text-muted-foreground",
  failed: "text-destructive",
  done: "text-git-added",
};

/** The status in words, for the expanded card: the header carries it as a dot only. */
export function statusWords(state: WorkerState, quietMs: number): string {
  switch (state) {
    case "needs-you": return "Needs you";
    case "quiet": return `Quiet for ${formatElapsed(quietMs)}`;
    case "running": return "Running";
    case "failed": return "Failed";
    case "done": return "Done";
  }
}

const endSentence = (text: string): string => (/[.?!]$/.test(text) ? text : `${text}.`);

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

/** Why a worker failed, or what it is waiting on you for: the only prose a worker card needs. */
export function WorkerNotes({ item, state }: { item: ToolItem; state: WorkerState }) {
  const output = item.output?.kind === "text" ? item.output.text : undefined;
  const failed = state === "failed";
  return (
    <>
      {failed && (
        <p role="alert" className="mb-1.5 flex gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-xs wrap-break-word">
          <AlertCircleIcon aria-hidden className="mt-px size-3.5 shrink-0 text-destructive" />
          <span className="min-w-0">{output ?? "The worker stopped before returning a result."}</span>
        </p>
      )}
      {state === "needs-you" && (
        <p className="mb-1.5 text-xs text-muted-foreground">{endSentence(waitingOn(item) ?? "Waiting for you")} Answer it above the composer.</p>
      )}
    </>
  );
}

/** The worker's few actions as icons on its own header line: Stop only while it runs, then Message (Follow up once it has settled) and the menu. */
export function WorkerActions({ hostedId, state, messaging, onToggleMessage, onOpenTranscript }: {
  hostedId: SessionId; state: WorkerState; messaging: boolean; onToggleMessage: () => void; onOpenTranscript: () => void;
}) {
  const { post } = useStore();
  const running = state === "running" || state === "quiet";
  const settled = state === "failed" || state === "done";
  const quiet = "text-muted-foreground hover:text-foreground";
  return (
    <span className="flex shrink-0 items-center">
      {running && (
        <Button variant="ghost" size="icon-xs" className={quiet} aria-label="Stop this worker" title="Stop this worker" onClick={() => post({ t: "interrupt", id: hostedId })}>
          <SquareIcon aria-hidden className="fill-current" />
        </Button>
      )}
      <Button variant="ghost" size="icon-xs" className={cn(quiet, messaging && "text-foreground")} aria-pressed={messaging} aria-label={settled ? "Follow up" : "Message"} title={settled ? "Follow up with this worker" : "Message this worker"} onClick={onToggleMessage}>
        <MessageSquareIcon aria-hidden />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className={quiet} aria-label="More worker actions" />}>
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
    </span>
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
