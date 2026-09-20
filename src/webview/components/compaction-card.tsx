import { ChevronRightIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { TranscriptItem } from '../../protocol/messages';
import { Markdown } from './markdown';
import { TranscriptItemShell } from './transcript-item-shell';

type CompactionItem = Extract<TranscriptItem, { role: 'compaction' }>;

function headline(item: CompactionItem): string {
  if (item.state === 'running') { return 'Compacting conversation…'; }
  if (item.state === 'failed') { return 'Compaction failed'; }
  return item.trigger === 'auto' ? 'Conversation compacted automatically' : 'Conversation compacted';
}

export function CompactionCard({ item }: { item: CompactionItem }) {
  const [open, setOpen] = useState(false);
  const summary = item.state === 'done' ? item.summary : undefined;

  return (
    <TranscriptItemShell role="tool" label="Compact" ts={item.ts}>
      <div className={cn('text-xs', item.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
        {summary ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-auto gap-1 px-0 py-0 text-xs text-muted-foreground"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <ChevronRightIcon aria-hidden className={cn('size-3 transition-transform', open && 'rotate-90')} />
            {headline(item)} — {open ? 'hide' : 'show'} summary
          </Button>
        ) : (
          <span>{headline(item)}{item.error ? `: ${item.error}` : ''}</span>
        )}
      </div>
      {summary && open && (
        <div className="mt-1 max-h-96 overflow-auto rounded border border-border px-2 py-1 text-xs">
          <Markdown>{summary}</Markdown>
        </div>
      )}
    </TranscriptItemShell>
  );
}
