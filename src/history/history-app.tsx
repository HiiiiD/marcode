import { useState } from 'react';
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
    <div className="flex min-h-screen flex-col text-foreground">
      <HistoryToolbar query={query} onChange={setQuery} />
      <MemoryStrip />
      {body}
    </div>
  );
}
