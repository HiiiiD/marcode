import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { TranscriptItem } from '../../protocol/messages';
import { safeStringify, summarize } from './tool-card-format';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

export function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const dot = item.state === 'running' ? '○' : item.state === 'ok' ? '●' : '✕';

  return (
    <div className="my-1 rounded border border-border text-xs">
      <Button
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        className="flex h-auto w-full items-center justify-start gap-2 px-2 py-1 font-normal"
      >
        <span aria-hidden>{dot}</span>
        <span className="font-medium">{item.name}</span>
        <span className="truncate text-muted-foreground">{summarize(item.input)}</span>
      </Button>
      {open && (
        <pre className="overflow-x-auto border-t border-border px-2 py-1">
{safeStringify({ input: item.input, output: item.output })}
        </pre>
      )}
    </div>
  );
}
