import { useEffect, useState } from 'react';
import {
  TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger,
} from '@/components/ui/trace';
import { ProviderStack } from './provider-stack';
import { memberState, SubagentCard } from './subagent-card';
import { workerState, type WorkerState } from './worker-controls';
import { TranscriptItemShell } from './transcript-item-shell';
import { activitySignature, useLastChanges } from '../lib/last-change';
import { subagentLabel, summarizeSubagent } from '../../client-core/subagent-window';
import type { SessionId, TranscriptItem } from '../../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

export function SubagentGroupCard({ items, sessionId }: { items: ToolItem[]; sessionId: SessionId }) {
  const [open, setOpen] = useState(false);
  const [manuallyCollapsed, setManuallyCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const anyRunning = items.some((i) => i.state === 'running');
  const changes = useLastChanges(items.map((item) => ({ id: item.id, signature: activitySignature(item) })));

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
      state: memberState(item, blocked, now, changes.get(item.id) ?? now),
    };
  });
  const blockedCount = members.filter((m) => m.state === 'blocked').length;
  const states = items.map((item) => workerState(item, summarizeSubagent(item, now).blocked, now, changes.get(item.id) ?? now));
  const count = (st: WorkerState) => states.filter((x) => x === st).length;
  const attention = blockedCount > 0 || count('failed') > 0 || count('quiet') > 0;
  const expanded = open || (attention && !manuallyCollapsed);

  return (
    <TranscriptItemShell role="subagent" label="Team" ts={items[0].ts}>
      <TraceCollapsible
        bare
        className="group/item my-0"
        open={expanded}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next && attention) { setManuallyCollapsed(true); }
        }}
      >
        <TraceCollapsibleTrigger className="h-7 w-full flex-none px-0 text-xs hover:bg-transparent [&>[data-slot=trace-icon]:last-child]:opacity-40 group-hover/item:[&>[data-slot=trace-icon]:last-child]:opacity-100 focus-visible:[&>[data-slot=trace-icon]:last-child]:opacity-100 aria-expanded:[&>[data-slot=trace-icon]:last-child]:opacity-100">
          <ProviderStack className="ml-1 -space-x-1.5" members={members} max={8} />
          <span className="shrink-0 font-medium">{items.length} workers</span>
          <span className="sr-only">{blockedCount > 0 ? 'needs you' : ''}</span>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="mt-0.5 mb-2 ml-2 border-t-0 border-l border-border py-0 pl-3">
          <div className="flex flex-col gap-1">
            {items.map((item) => <SubagentCard key={item.id} item={item} sessionId={sessionId} embedded />)}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </TranscriptItemShell>
  );
}
