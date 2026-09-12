import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Minutes-only cadence, matching native: `${m}m` under an hour, `${h}h ${m}m` under a day. */
function idleLabel(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) { return `${minutes}m`; }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

type CacheState =
  | { kind: 'warm'; minutesLeft: number }
  | { kind: 'cold'; idleMs: number };

function stateOf(window: { anchorAt: number; ttlMs: number }, now: number): CacheState {
  const msLeft = window.anchorAt + window.ttlMs - now;
  if (msLeft > 0) { return { kind: 'warm', minutesLeft: Math.ceil(msLeft / 60000) }; }
  return { kind: 'cold', idleMs: now - (window.anchorAt + window.ttlMs) };
}

function sentenceFor(state: CacheState): string {
  return state.kind === 'warm'
    ? `Prompt cache warm, about ${state.minutesLeft} min left.`
    : `Prompt cache likely expired (idle ${idleLabel(state.idleMs)}).`;
}

/** The badge's own visible text — always shown, color carries warm/cold, not presence. */
function labelFor(state: CacheState): string {
  return state.kind === 'warm' ? `${state.minutesLeft}m` : idleLabel(state.idleMs);
}

/**
 * Read-only status, not a control — same `role="status"` treatment as the
 * attachment-error live region in composer.tsx. `aria-live="off"`: this
 * ticks every 15s while a turn is fresh, and a live region here would turn a
 * warm session into a screen reader ticking over the user's work.
 *
 * Ticks off a local interval rather than the host, same reasoning as
 * WorkingRow — the host would have to re-push this every 15s for every
 * visible session just to keep a label current, for a number derivable
 * entirely from a timestamp already on the wire.
 */
export function CacheTimer({ window }: { window?: { anchorAt: number; ttlMs: number } }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!window) { return; }
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [window]);

  if (!window) { return null; }

  const state = stateOf(window, now);
  const sentence = sentenceFor(state);

  return (
    <span
      role="status"
      aria-live="off"
      aria-label={sentence}
      title={sentence}
      data-cache-window={state.kind}
      // Color is the only signal for warm/cold — the icon and label never
      // change shape, so a colorblind-unsafe read still has the tooltip's
      // full sentence as the real answer, same as StatusBadge's dot+text.
      className={cn(
        'flex items-center gap-1 text-xs tabular-nums',
        state.kind === 'warm' ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      <Clock className="size-3.5" aria-hidden />
      {labelFor(state)}
    </span>
  );
}
