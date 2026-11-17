import { useState } from 'react';
import { BrainIcon } from 'lucide-react';
import { TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger } from '@/components/ui/trace';
import { InlineMarkdown } from './inline-markdown';
import { Markdown } from './markdown';

/**
 * The first line worth showing. Reasoning routinely starts with a blank line
 * or two, and a preview that renders empty spends a row saying nothing.
 */
function preview(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) { return trimmed.length > 90 ? `${trimmed.slice(0, trimmed.lastIndexOf(' ', 90))}…` : trimmed; }
  }
  return '';
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
      <TraceCollapsibleTrigger className="h-6 px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground [&>[data-slot=trace-icon]:last-child]:opacity-0 group-hover/item:[&>[data-slot=trace-icon]:last-child]:opacity-100 focus-visible:[&>[data-slot=trace-icon]:last-child]:opacity-100 aria-expanded:[&>[data-slot=trace-icon]:last-child]:opacity-100">
        <BrainIcon aria-hidden className="shrink-0" />
        <span className="shrink-0 font-medium text-foreground/80">Reasoning</span>
        <span className="min-w-0 truncate text-muted-foreground">
          <InlineMarkdown>{preview(text)}</InlineMarkdown>
        </span>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent inset className="max-h-64 overflow-y-auto text-muted-foreground">
        <Markdown>{text}</Markdown>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
