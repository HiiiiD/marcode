import { useStore } from './store';
import { SessionCard } from './session-card';
import type { SessionSummary } from '../protocol/messages';

/**
 * A stable card order, independent of `sessions-changed`'s own sort.
 *
 * `SessionManager.summaries()` sorts by `updatedAt` descending, and
 * `AgentSession.refreshActivityLabel()` calls `changed()` (which re-sends
 * `sessions-changed`) on every `tool-start`/`tool-end` — so a grid that just
 * rendered `state.sessions` in wire order would visibly reorder itself on
 * every tool call. `createdAt` (roster order), not `updatedAt`, is what a
 * grid the user is scanning by eye needs to hold still; `id` breaks a tie
 * between two sessions created in the same millisecond.
 */
function byCreationOrder(a: SessionSummary, b: SessionSummary): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

export function FleetApp() {
  const { state } = useStore();
  if (!state.ready) {
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  }
  const live = [...state.sessions].filter((s) => !s.archived).sort(byCreationOrder);
  if (live.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">No sessions yet.</div>;
  }
  return (
    <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3 lg:grid-cols-4">
      {live.map((s) => <SessionCard key={s.id} session={s} />)}
    </div>
  );
}
