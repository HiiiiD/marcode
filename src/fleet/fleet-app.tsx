import { useStore } from './store';
import { SessionCard } from './session-card';

export function FleetApp() {
  const { state } = useStore();
  if (!state.ready) {
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  }
  const live = state.sessions.filter((s) => !s.archived);
  if (live.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">No sessions yet.</div>;
  }
  return (
    <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3 lg:grid-cols-4">
      {live.map((s) => <SessionCard key={s.id} session={s} />)}
    </div>
  );
}
