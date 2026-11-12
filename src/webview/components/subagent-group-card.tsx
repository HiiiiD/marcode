import { useEffect, useState } from 'react';
import {
  TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger,
} from '@/components/ui/trace';
import { ProviderStack } from './provider-stack';
import { memberState, SubagentCard } from './subagent-card';
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
  const runningCount = members.filter((m) => m.state === 'running').length;
  const failedCount = members.filter((m) => m.state === 'failed').length;
  const expanded = open || (blockedCount > 0 && !manuallyCollapsed);

  return (
    <TranscriptItemShell role="subagent" label="Team" ts={items[0].ts}>
      <TraceCollapsible
        open={expanded}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next && blockedCount > 0) { setManuallyCollapsed(true); }
        }}
      >
        <TraceCollapsibleTrigger className="w-full flex-none">
          <ProviderStack members={members} />
          <span className="truncate font-medium">{items.length} workers</span>
          <span className="shrink-0 text-muted-foreground">
            {runningCount > 0 ? `${runningCount} running` : failedCount > 0 ? `${failedCount} failed` : 'done'}
          </span>
          <span className="sr-only">{blockedCount > 0 ? 'needs you' : ''}</span>
          {blockedCount > 0 && (
            <span className="ml-auto shrink-0 rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-medium">
              {blockedCount} need{blockedCount === 1 ? 's' : ''} you
            </span>
          )}
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
