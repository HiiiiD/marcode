import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Dead air, made visible: the turn is running and nothing has arrived yet.
 *
 * `since` is a host timestamp, not a mount time, so what the clock reports is
 * how long it has been since anything actually happened — which survives a
 * window reload, and is the number that answers the only question being asked
 * here ("is this alive, or should I go look at it?"). A mount-relative timer
 * would restart at 0:00 after a reload and quietly lie about a stuck turn.
 *
 * The count is `aria-hidden`: it changes every second, and any live region
 * around it would turn a waiting agent into a screen reader ticking over the
 * user's work. Status changes are announced once, by StatusBadge, which is
 * where they belong.
 */
export function WorkingRow({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    // pl-2.5 rather than pl-2: the transcript items are indented by a 2px
    // gutter rule plus pl-2, and this row has no rule to contribute the 2px.
    <div className="my-0 flex items-center gap-2 pl-2.5 text-xs text-muted-foreground">
      <span aria-hidden className="flex shrink-0 items-center gap-1">
        {['', '[animation-delay:140ms]', '[animation-delay:280ms]'].map((delay, i) => (
          <span
            key={i}
            className={cn(
              // motion-reduce leaves the dots at their own opacity rather
              // than at the keyframe floor, so the row still reads as three
              // dots and a label when the animation is off.
              'size-1 rounded-full bg-current animate-working-dot motion-reduce:animate-none',
              delay,
            )}
          />
        ))}
      </span>
      <span>Working…</span>
      <span aria-hidden className="ml-auto tabular-nums">{elapsed(now - since)}</span>
    </div>
  );
}
