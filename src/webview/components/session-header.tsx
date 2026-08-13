import { Button } from '@/components/ui/button';
import { useStore } from '../store';
import type { PaneState } from '../reducer';
import type { ModelInfo, SessionStatus } from '../../protocol/messages';

const DOT: Record<SessionStatus, string> = {
  idle: 'bg-muted-foreground',
  running: 'bg-primary animate-pulse',
  'awaiting-approval': 'bg-destructive',
  error: 'bg-destructive',
};

export function SessionHeader({ pane, models }: { pane: PaneState; models: ModelInfo[] }) {
  const { post } = useStore();
  const s = pane.summary;
  const modelLabel = models.find((m) => m.id === s.model)?.displayName ?? s.model;

  return (
    <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
      <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[s.status]}`} aria-hidden />
      <span className="truncate font-medium" title={s.title}>{s.title}</span>
      <span className="ml-auto shrink-0 text-muted-foreground">
        {modelLabel}{s.effort ? ` · ${s.effort}` : ''}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Close session"
        onClick={() => post({ t: 'close-session', id: s.id })}
        className="h-5 w-5 shrink-0"
      >
        ×
      </Button>
    </div>
  );
}
