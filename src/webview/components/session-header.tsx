import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { evenlySizedPanes } from './pane-layout';
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
  const { state, post } = useStore();
  const s = pane.summary;
  const modelLabel = models.find((m) => m.id === s.model)?.displayName ?? s.model;

  return (
    <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
      <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[s.status])} aria-hidden />
      <span className="truncate font-medium" title={s.title}>{s.title}</span>
      {s.permissionMode === 'bypass' && (
        // Text, not a bare colored dot: a color alone would be invisible to
        // a colorblind user and meaningless to a new one. `role="status"`
        // exposes it to assistive tech even though it renders no live
        // announcement region elsewhere. Lives in the header (not just the
        // composer's Select) because the composer can scroll out of view
        // during a long turn while this header does not.
        <span
          role="status"
          className={cn(
            'shrink-0 rounded-full border border-destructive/40 bg-destructive/10',
            'px-1.5 py-0.5 text-[0.7rem] font-medium text-destructive dark:bg-destructive/20',
          )}
        >
          Bypassing permissions
        </span>
      )}
      <span className="ml-auto shrink-0 text-muted-foreground">
        {modelLabel}{s.effort ? ` · ${s.effort}` : ''}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Close session ${s.title}`}
        onClick={() => {
          // `close-session` alone only flips the session to archived on the
          // host and revokes its visibility (SessionManager.close) — it does
          // NOT touch the layout. Eligibility for a pane is roster
          // membership, not archived status (see pane-layout.ts), so
          // without also dropping this pane from the layout here, the pane
          // would keep rendering — now permanently patch-less, since the
          // host no longer considers it visible — until the user happened
          // to toggle it off/on in the roster picker or reload the window.
          // Post the layout change too, exactly like the roster picker's
          // uncheck does, so `paneIdsKey` changes and the app's
          // `set-visible` effect re-syncs the host.
          const remaining = state.layout.panes
            .map((p) => p.sessionId)
            .filter((id) => id !== s.id);
          post({ t: 'set-layout', layout: evenlySizedPanes(remaining, state.layout.orientation) });
          post({ t: 'close-session', id: s.id });
        }}
        className="shrink-0"
      >
        ×
      </Button>
    </div>
  );
}
