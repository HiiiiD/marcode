import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AlertCircleIcon, ExternalLinkIcon, MessageSquareIcon, MoreHorizontalIcon, PanelTopOpenIcon, SendIcon, SquareIcon } from "lucide-react";
import { formatElapsed } from "../../client-core/subagent-window";
import type { SessionId, TranscriptItem } from "../../protocol/messages";
import { useStore } from "../store";
import { workerFailure, type WorkerState } from "../../client-core/worker-status";

type ToolItem = Extract<TranscriptItem, { role: "tool" }>;

export { quietFor, statusWords, workerState, type WorkerState } from "../../client-core/worker-status";

export const STATUS_TONE: Record<WorkerState, string> = {
  "needs-you": "text-primary",
  quiet: "text-attention",
  running: "text-muted-foreground",
  failed: "text-destructive",
  done: "text-git-added",
};

/** Why a worker failed: the only prose a worker card needs. A question or approval it raises is answered in the parent's own prompt strip, so it says nothing about that here. */
export function WorkerNotes({ item, state }: { item: ToolItem; state: WorkerState }) {
  const failure = workerFailure(item, state);
  return (
    <>
      {failure !== undefined && (
        <p role="alert" className="mb-1.5 flex gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-xs wrap-break-word">
          <AlertCircleIcon aria-hidden className="mt-px size-3.5 shrink-0 text-destructive" />
          <span className="min-w-0">{failure}</span>
        </p>
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
