import {
  TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger,
} from '@/components/ui/trace';
import { Markdown } from './markdown';
import { useNestedMessages } from './nested-messages-context';
import { parseWorkerMessage } from '../lib/worker-message';

export function NestedMessageList({ childId }: { childId: string | undefined }) {
  const messages = useNestedMessages(childId);
  if (messages.length === 0) { return null; }
  return (
    <ul aria-label="Messages from this worker" className="mb-1 flex flex-col gap-0.5">
      {messages.map((m) => {
        const { label, body, preview } = parseWorkerMessage(m.text);
        return (
          <li key={m.id}>
            <TraceCollapsible>
              <TraceCollapsibleTrigger className="w-full flex-none">
                <span className="shrink-0 font-medium">{label}</span>
                <span className="truncate text-muted-foreground">{preview}</span>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent className="py-1">
                <div className="max-h-64 overflow-auto pr-1 text-xs"><Markdown>{body}</Markdown></div>
              </TraceCollapsibleContent>
            </TraceCollapsible>
          </li>
        );
      })}
    </ul>
  );
}
