import { useState } from 'react';
import { CheckIcon, Loader2Icon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { TranscriptItem } from '../../protocol/messages';
import { safeStringify, summarize } from './tool-card-format';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

export function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const StateIcon = item.state === 'running' ? Loader2Icon
    : item.state === 'ok' ? CheckIcon : XIcon;

  return (
    <div className="my-0 rounded border border-border text-xs">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`tool-${item.toolId}`}
        // `gap-2`/`px-2`/`justify-start` override `size="sm"`'s own gap/px —
        // the fixed h-7 the variant sets is kept, not hand-written, per the
        // Task 2 discipline against overriding a size variant's height.
        className="flex w-full items-center justify-start gap-2 px-2 font-normal"
      >
        <StateIcon aria-hidden className={cn(item.state === 'running' && 'animate-spin')} />
        <span className="sr-only">{item.state}</span>
        {item.mcpServer && (
          // Muted, not colour-per-server: a palette per server would collide
          // with the status tones already in use and buys nothing when the
          // name is right beside it. This is a permanent record — the value
          // is parsed host-side at item creation, so removing the server
          // later cannot rewrite what already happened.
          <span className="shrink-0 rounded bg-muted px-1 text-muted-foreground">
            {item.mcpServer}
          </span>
        )}
        <span className="font-medium">{item.name}</span>
        <span className="truncate text-muted-foreground">{summarize(item.input)}</span>
      </Button>
      {open && (
        <pre id={`tool-${item.toolId}`} className="border-t border-border px-2 py-1 wrap-break-word whitespace-pre-wrap">
{safeStringify({ input: item.input, output: item.output })}
        </pre>
      )}
    </div>
  );
}
