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
      <span className="truncate text-muted-foreground">{session.activityLabel ?? 'Idle'}</span>
    </Button>
  );
}
