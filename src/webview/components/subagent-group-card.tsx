import { useEffect, useState } from 'react';
import {
  TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger,
} from '@/components/ui/trace';
import { ProviderStack } from './provider-stack';
import { memberState, SubagentCard } from './subagent-card';
import { WorkerChip, workerState, type WorkerState } from './worker-controls';
import { TranscriptItemShell } from './transcript-item-shell';
import { subagentLabel, summarizeSubagent } from '../../client-core/subagent-window';
import type { SessionId, TranscriptItem } from '../../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

export function SubagentGroupCard({ items, sessionId }: { items: ToolItem[]; sessionId: SessionId }) {
  const [open, setOpen] = useState(false);
  const [manuallyCollapsed, setManuallyCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const anyRunning = items.some((i) => i.state === 'running');

  useEffect(() => {
    if (!anyRunning) { return; }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  const members = items.map((item) => {
    const blocked = summarizeSubagent(item, now).blocked;
    return {
      providerId: item.tool.kind === 'subagent' ? item.tool.provider : undefined,
      name: subagentLabel(item),
      state: memberState(item, blocked),
    };
  });
  const blockedCount = members.filter((m) => m.state === 'blocked').length;
  const states = items.map((item) => workerState(item, summarizeSubagent(item, now).blocked, now));
  const count = (st: WorkerState) => states.filter((x) => x === st).length;
  const healthy = count('running') + count('done');
  const attention = blockedCount > 0 || count('failed') > 0 || count('quiet') > 0;
  const expanded = open || (attention && !manuallyCollapsed);

  return (
    <TranscriptItemShell role="subagent" label="Team" ts={items[0].ts}>
      <TraceCollapsible
        open={expanded}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next && attention) { setManuallyCollapsed(true); }
        }}
      >
        <TraceCollapsibleTrigger className="w-full flex-none">
          <ProviderStack members={members} />
          <span className="shrink-0 font-medium">{items.length} workers</span>
          <span className="sr-only">{blockedCount > 0 ? 'needs you' : ''}</span>
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            {/* Only what needs a look gets a chip; everything fine is one quiet count, so the row reads as "is anything wrong". */}
            {(['needs-you', 'failed', 'quiet'] as const).map((st) => {
              const n = count(st);
              return n > 0 ? <span key={st} className="flex shrink-0 items-center gap-1"><WorkerChip state={st} />{n > 1 && <span className="text-muted-foreground tabular-nums">×{n}</span>}</span> : null;
            })}
            <span className="truncate text-muted-foreground">
              {attention
                ? healthy > 0 ? `+${healthy} ok` : ''
                : count('running') > 0 ? `${count('running')} running${count('done') > 0 ? ` · ${count('done')} done` : ''}` : 'done'}
            </span>
          </span>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="py-1">
          <div className="flex flex-col gap-1">
            {items.map((item) => <SubagentCard key={item.id} item={item} sessionId={sessionId} embedded />)}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </TranscriptItemShell>
  );
}
