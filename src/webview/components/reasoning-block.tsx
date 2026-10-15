import { useState } from 'react';
import {
  TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger,
  TraceDescription, TraceLine, TraceTitle,
} from '@/components/ui/trace';
import { InlineMarkdown } from './inline-markdown';
import { Markdown } from './markdown';

/**
 * The first line worth showing. Reasoning routinely starts with a blank line
 * or two, and a preview row that renders empty is worse than no preview: it
 * spends a line of a 300px column saying nothing.
 */
function preview(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) { return trimmed; }
  }
  return '';
}

/**
 * Reasoning, always collapsed, never opening or closing on its own.
 *
 * The alternative — expand while it streams, fold when the answer arrives —
 * moves the answer under the reader's eye mid-sentence, twice per turn, in a
 * column narrow enough that the shift is the whole viewport. A permanently
 * quiet row costs one line and moves nothing.
 *
 * That makes the collapsed line carry the row's whole value, hence the
 * preview: "Reasoning" alone is a label for something you already know is
 * there. The first line tells you whether to open it.
 *
 * No glyph. The tool cards earn one because their glyph distinguishes a Bash
 * from a Read at a glance; reasoning has no kinds to tell apart, and a second
 * icon idiom inside the assistant item would only add weight.
 */
export function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);

  return (
    <TraceCollapsible open={open} onOpenChange={setOpen} className="mb-1 rounded-none border-0">
      <TraceCollapsibleTrigger className="h-6 w-fit max-w-full flex-none gap-1.5 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground">
        <TraceLine>
          <TraceTitle className="shrink-0 font-medium">Reasoning</TraceTitle>
          <TraceDescription className="min-w-0 shrink truncate italic">
            <InlineMarkdown>{preview(text)}</InlineMarkdown>
          </TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>

      <TraceCollapsibleContent className="mt-1 ml-2 max-h-48 overflow-auto border-t-0 border-l px-0 pl-3 py-0 text-muted-foreground">
        <Markdown>{text}</Markdown>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
