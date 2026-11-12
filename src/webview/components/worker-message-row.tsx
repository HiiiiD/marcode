import {
  TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger,
} from '@/components/ui/trace';
import { Markdown } from './markdown';
import type { NestedMessage } from './nested-messages-context';
import { parseWorkerMessage } from '../lib/worker-message';

export function WorkerMessageRow({ message }: { message: NestedMessage }) {
  const { label, body, preview } = parseWorkerMessage(message.text);
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger className="w-full flex-none">
        <span className="shrink-0 font-medium">{label}</span>
        <span className="truncate text-muted-foreground">{preview}</span>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="py-1">
        <div className="max-h-64 overflow-auto pr-1 text-xs"><Markdown>{body}</Markdown></div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
