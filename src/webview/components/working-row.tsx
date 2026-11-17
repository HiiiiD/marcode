import { useEffect, useState } from 'react';
import { AsteriskIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { describeTool } from '../../client-core/tool-render';
import type { PaneState } from '../reducer';
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

function turnStats(items: PaneState['items']): { start: number | undefined; tools: number; edits: number } {
  const from = items.map((i) => i.role).lastIndexOf('user');
  const turn = from === -1 ? items : items.slice(from);
  let tools = 0;
  let edits = 0;
  for (const item of turn) {
    if (item.role !== 'tool') { continue; }
    tools += 1;
    if (item.tool.kind === 'file-edit') { edits += 1; }
  }
  return { start: from === -1 ? undefined : items[from].ts, tools, edits };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The turn's one status line, pinned between the transcript and the composer:
 * it is present for the whole of a running turn, so it neither blinks in and
 * out between items nor moves the transcript, and it names the current step
 * rather than saying "working".
 *
 * Both clocks are host timestamps, not mount times, so a window reload does
 * not restart them: the first runs from the user's message, the "quiet" one
 * from the last event and appears only once that gap is long enough to be
 * worth a look. None of it is announced — it changes every second, and
 * StatusBadge already announces the status change once.
 */
export function WorkingRow({ pane }: { pane: PaneState }) {
  const [now, setNow] = useState(() => Date.now());
  const [mountedAt] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const last = pane.items[pane.items.length - 1];
  const { start, tools, edits } = turnStats(pane.items);
  const step = currentStep(last);
  const quiet = now - (last?.ts ?? mountedAt);
  const meta = [
    clock(now - (start ?? mountedAt)),
    tools > 0 ? plural(tools, 'tool') : null,
    edits > 0 ? plural(edits, 'edit') : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="@container flex min-h-7 shrink-0 items-center gap-2 px-3 text-xs text-muted-foreground">
      <AsteriskIcon aria-hidden className="size-3.5 shrink-0 text-primary motion-safe:animate-[spin_3s_linear_infinite]" />
      <span
        title={step}
        className={cn(
          'min-w-0 flex-1 truncate font-medium',
          'bg-[linear-gradient(90deg,var(--muted-foreground)_0%,var(--foreground)_50%,var(--muted-foreground)_100%)] bg-[length:200%_100%] bg-clip-text text-transparent',
          'motion-safe:animate-working-shimmer motion-reduce:bg-none motion-reduce:text-muted-foreground',
        )}
      >
        {step}
      </span>
      {quiet > QUIET_AFTER_MS && (
        <span aria-hidden className="shrink-0 tabular-nums text-attention">quiet {clock(quiet)}</span>
      )}
      <span aria-hidden className="shrink-0 tabular-nums">{meta}</span>
      <span aria-hidden className="hidden shrink-0 opacity-70 @[26rem]:inline">esc to stop</span>
    </div>
  );
}
