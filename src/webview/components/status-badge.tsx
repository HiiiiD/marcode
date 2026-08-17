import { cn } from '@/lib/utils';
import { statusView, type StatusView } from '../status';
import type { SessionStatus } from '../../protocol/messages';

const DOT: Record<StatusView['tone'], string> = {
  idle: 'bg-muted-foreground',
  busy: 'bg-primary animate-pulse',
  attention: 'bg-primary',
  failed: 'bg-destructive',
};

const CHIP: Record<StatusView['tone'], string> = {
  idle: 'text-muted-foreground',
  busy: 'text-muted-foreground',
  attention: 'border border-primary/40 bg-primary/10 text-foreground',
  failed: 'border border-destructive/40 bg-destructive/10 text-destructive',
};

/**
 * Text, not a colour alone — the same reasoning as the bypass badge in
 * session-header.tsx. `aria-live="polite"` sits on this span itself rather
 * than on some ancestor: `pane-group.tsx` keys `SessionHeader` by the
 * session id, not by status, so this span stays mounted across status
 * transitions and only its text content changes — which is exactly what a
 * live region needs to announce a change rather than saying nothing (region
 * created only after the fact) or announcing twice (region torn down and
 * rebuilt with the new content already inside it). A status change is the
 * one thing a user who is not looking at this pane most needs to hear: "the
 * agent is blocked on you" and "the agent failed" demand opposite responses
 * and used to render as the identical red dot.
 *
 * `hideIdle` renders no visible chip for `idle` — a quiet session earning no
 * space in a caller like the review tab's group header, where every group
 * would otherwise carry a permanent "Idle" pill — while still returning the
 * same `<span aria-live>` node in the same position, so React reuses it
 * rather than mounting a fresh, empty region the moment the caller does have
 * something to announce. A caller that always wants the chip (session-header)
 * leaves this off.
 */
export function StatusBadge({ status, hideIdle }: { status: SessionStatus; hideIdle?: boolean }) {
  const view = statusView(status);
  if (hideIdle && status === 'idle') {
    return <span aria-live="polite" className="sr-only" />;
  }
  return (
    <span
      aria-live="polite"
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.7rem] font-medium',
        CHIP[view.tone],
      )}
    >
      <span className={cn('size-2 rounded-full', DOT[view.tone])} aria-hidden />
      {view.label}
    </span>
  );
}
