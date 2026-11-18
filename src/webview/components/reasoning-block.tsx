import { useState } from 'react';
import { cn } from '@/lib/utils';
import { LightbulbIcon } from 'lucide-react';
import { TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger } from '@/components/ui/trace';
import { InlineMarkdown } from './inline-markdown';
import { Markdown } from './markdown';

/**
 * The first line worth showing. Reasoning routinely starts with a blank line
 * or two, and a preview that renders empty spends a row saying nothing.
 */
function preview(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.slice(0, 2).join(' ');
}

/**
 * Reasoning, as one more row of the work log: the same parts as a tool call
 * (glyph, name, one line of what it is about, a chevron that appears on hover,
 * a soft inset when opened), so it lines up and weighs the same as the rows
 * around it.
 *
 * Always collapsed and never opening or closing on its own: expanding while it
 * streams and folding when the answer arrives would move the answer under the
 * reader's eye twice per turn.
 */
export function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);

  return (
    <TraceCollapsible bare open={open} onOpenChange={setOpen} className="group/item my-0">
      <TraceCollapsibleTrigger className={cn("h-7 flex-none items-center gap-2 py-0 pr-7 pl-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground [&>[data-slot=trace-icon]:last-child]:opacity-40 group-hover/item:[&>[data-slot=trace-icon]:last-child]:opacity-100 focus-visible:[&>[data-slot=trace-icon]:last-child]:opacity-100 aria-expanded:[&>[data-slot=trace-icon]:last-child]:opacity-100", open && "min-h-6 pb-0")}>
        <LightbulbIcon aria-hidden className="shrink-0" />
        <span className="min-w-[5.5rem] shrink-0 text-muted-foreground">Reasoning</span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-foreground/70">
            <InlineMarkdown>{preview(text)}</InlineMarkdown>
          </span>
        )}
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent inset className="max-h-64 overflow-y-auto text-foreground/80 [&_p]:my-0 [&_p+p]:mt-2">
        <Markdown>{text}</Markdown>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
