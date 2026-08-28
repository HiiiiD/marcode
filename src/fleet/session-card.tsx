import { Button } from '@/components/ui/button';
import { StatusBadge } from '../webview/components/status-badge';
import { useStore } from './store';
import type { SessionSummary } from '../protocol/messages';

export function SessionCard({ session }: { session: SessionSummary }) {
  const { post } = useStore();
  return (
    <Button
      variant="outline"
      className="flex h-auto w-full flex-col items-start gap-1 p-2 text-left text-xs font-normal"
      onClick={() => post({ t: 'focus-session', id: session.id })}
    >
      <div className="flex w-full items-center gap-2">
        <span className="truncate font-medium">{session.title}</span>
        <StatusBadge status={session.status} />
      </div>
      {/*
        Always the model, never conditioned on a provider count: unlike
        session-header.tsx's provider label (which only shows once a
        multi-provider catalog makes the provider itself informative), the
        fleet client's `FleetState` deliberately carries no catalog (just
        `{ ready, sessions }` per the spec), and `model` is unconditionally
        present on every `SessionSummary` — the simplest way to identify a
        card without growing that state.
      */}
      <span className="truncate text-muted-foreground">{session.model}</span>
      <span className="truncate text-muted-foreground">{session.activityLabel ?? 'Idle'}</span>
    </Button>
  );
}
