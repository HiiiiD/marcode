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
    <div className="my-1 rounded border border-border text-xs">
      <Button
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`tool-${item.toolId}`}
        className="flex h-auto w-full items-center justify-start gap-2 px-2 py-1 font-normal"
      >
        <StateIcon aria-hidden className={cn(item.state === 'running' && 'animate-spin')} />
        <span className="sr-only">{item.state}</span>
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
