import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { HistoryTable } from './history-table';
import { HistoryToolbar } from './history-toolbar';
import { MemoryStrip } from './memory-strip';
import { MoveDialog, MoveRequest } from './move-dialog';
import { DEFAULT_QUERY, needsAttention, queryHistory, type HistoryQuery } from './history-rows';
import { useStore } from './store';
import type { SessionId } from '../protocol/messages';

export function HistoryApp() {
  const { state, post } = useStore();
  const [moving, setMoving] = useState<SessionId | null>(null);
  const requestMove = (id: SessionId) => { setMoving(id); post({ t: 'request-move-panel', id }); };
  // Ephemeral by design: a reading position in a list that keeps changing.
  const [query, setQuery] = useState<HistoryQuery>(DEFAULT_QUERY);
  const groups = queryHistory(state.sessions, query);
  const attentionCount = state.sessions.filter(needsAttention).length;
  const shownCount = groups.pinned.length + groups.rest.length + groups.devices.reduce((n, g) => n + g.sessions.length, 0);
  const filtered = query.needsAttention === true || query.text.trim() !== '';
  const empty = shownCount === 0;

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
      <MoveRequest.Provider value={requestMove}>
      <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col text-sm text-foreground">
        <HistoryToolbar query={query} attentionCount={attentionCount} onChange={setQuery} />
        {filtered && (
          <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-xs text-muted-foreground">
            <span>
              {`Showing ${shownCount} of ${state.sessions.length} sessions`}
              {query.needsAttention ? ' that need attention' : ''}
            </span>
            <Button variant="link" size="xs" onClick={() => setQuery({ ...query, needsAttention: false, text: '' })}>Clear</Button>
          </div>
        )}
        <MemoryStrip />
        {body}
      </div>
      <MoveDialog id={moving} onClose={() => { setMoving(null); }} />
      </MoveRequest.Provider>
    </TooltipProvider>
  );
}
