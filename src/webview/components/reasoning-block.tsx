import { useState } from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
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
    <Collapsible open={open} onOpenChange={setOpen} className="mb-1 text-xs">
      <CollapsibleTrigger
        render={
          // gap/px/justify override `size="sm"`'s own, keeping the h-7 the
          // variant sets rather than hand-writing a height.
          <Button
            variant="ghost"
            size="sm"
            className="flex w-full items-center justify-start gap-1.5 px-1 font-normal"
          />
        }
      >
        <ChevronRightIcon
          aria-hidden
          className={cn('shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-90')}
        />
        <span className="shrink-0 font-medium">Reasoning</span>
        <span className="min-w-0 truncate text-muted-foreground italic">
          <InlineMarkdown>{preview(text)}</InlineMarkdown>
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="max-h-48 overflow-auto border-l border-border pl-2 text-muted-foreground">
          <Markdown>{text}</Markdown>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
