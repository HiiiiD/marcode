import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { describeTool } from '../../client-core/tool-render';
import type { TranscriptItem } from '../../protocol/messages';

const QUIET_AFTER_MS = 60_000;

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** What the agent is doing right now, read off the tail of the transcript. */
export function currentStep(last: TranscriptItem | undefined): string {
  if (!last || last.role === 'user') { return 'Working…'; }
  if (last.role === 'tool') {
    if (last.state !== 'running') { return 'Thinking…'; }
    const { verb, primary } = describeTool(last.tool);
    return primary ? `${verb} · ${primary}` : verb;
  }
  if (last.role === 'assistant') { return last.text.trim() ? 'Writing…' : 'Thinking…'; }
  return 'Working…';
}

/**
 * The turn's one status line: present for the whole of a running turn, so it
 * never blinks in and out between items, and it names the current step rather
 * than saying "working".
 *
 * Both clocks are host timestamps, not mount times, so a window reload does
 * not restart them: the big one runs from the user's message, the "quiet"
 * one from the last event, and only appears once that gap is long enough to be
 * worth a look. Neither is announced — they change every second, and
 * StatusBadge already announces the status change once.
 */
export function WorkingRow({ turnStart, lastEventAt, last }: {
  turnStart: number;
  lastEventAt: number;
  last: TranscriptItem | undefined;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const quiet = now - lastEventAt;

  return (
    <div className="my-0 flex min-h-7 items-center gap-2 rounded-md border border-border bg-muted/30 px-2 text-xs text-muted-foreground">
      <span aria-hidden className="relative flex size-2 shrink-0">
        <span className="absolute inline-flex size-full rounded-full bg-primary/50 motion-safe:animate-ping" />
        <span className="relative inline-flex size-2 rounded-full bg-primary" />
      </span>
      <span className="min-w-0 flex-1 truncate" title={currentStep(last)}>{currentStep(last)}</span>
      {quiet > QUIET_AFTER_MS && (
        <span aria-hidden className={cn('shrink-0 tabular-nums text-attention')}>
          quiet {clock(quiet)}
        </span>
      )}
      <span aria-hidden className="shrink-0 tabular-nums">{clock(now - turnStart)}</span>
    </div>
  );
}
