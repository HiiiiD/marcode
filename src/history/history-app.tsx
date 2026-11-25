import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { HistoryTable } from './history-table';
import { HistoryToolbar } from './history-toolbar';
import { MemoryStrip } from './memory-strip';
import { DEFAULT_QUERY, queryHistory, type HistoryQuery } from './history-rows';
import { useStore } from './store';

export function HistoryApp() {
  const { state } = useStore();
  // Ephemeral by design: a reading position in a list that keeps changing.
  const [query, setQuery] = useState<HistoryQuery>(DEFAULT_QUERY);
  const groups = queryHistory(state.sessions, query);
  const attentionCount = state.sessions.filter((s) => s.status === 'awaiting-approval' || s.status === 'error').length;
  const empty = groups.pinned.length + groups.rest.length === 0;

  let body;
  if (!state.ready) {
    body = <p className="px-3 py-6 text-xs text-muted-foreground">Loading sessions…</p>;
  } else if (empty) {
    body = (
      <p className="px-3 py-6 text-xs text-muted-foreground">
        {state.sessions.length === 0 ? 'No sessions yet' : 'No sessions match'}
      </p>
    );
  } else {
    body = <HistoryTable groups={groups} />;
  }

  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col text-foreground">
        <HistoryToolbar query={query} attentionCount={attentionCount} onChange={setQuery} />
        {query.needsAttention && (
          <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-xs text-muted-foreground">
            <span>Showing only sessions that need attention</span>
            <Button variant="link" size="xs" onClick={() => setQuery({ ...query, needsAttention: false })}>Clear</Button>
          </div>
        )}
        <MemoryStrip />
        {body}
      </div>
    </TooltipProvider>
  );
}
