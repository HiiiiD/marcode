import { useId, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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
  const bodyId = useId();
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className="mb-1 text-xs">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        // gap/px/justify override `size="sm"`'s own, keeping the h-7 the
        // variant sets rather than hand-writing a height — the same
        // discipline as the tool-card header this borrows its shape from.
        className="flex w-full items-center justify-start gap-1.5 px-1 font-normal"
      >
        <Chevron aria-hidden className="shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">Reasoning</span>
        <span className="min-w-0 truncate text-muted-foreground italic">{preview(text)}</span>
      </Button>

      {open && (
        <div
          id={bodyId}
          className="max-h-48 overflow-auto border-l-2 border-border pl-2 wrap-break-word whitespace-pre-wrap text-muted-foreground italic"
        >
          {text}
        </div>
      )}
    </div>
  );
}
