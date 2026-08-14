import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ContextDialog, DANGER_PERCENT } from './context-dialog';
import { Ring } from './ring';
import type { PaneState } from '../reducer';

/**
 * The context-fill ring in the composer, and the door it opens.
 *
 * `open`/`onOpenChange` are optional: the ring manages the dialog itself
 * unless something else needs the same door — the composer passes them so an
 * intercepted `/context` opens this one dialog rather than mounting a second
 * copy of the same surface.
 */
export function ContextRing({
  pane, open: openProp, onOpenChange,
}: { pane: PaneState; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = openProp ?? uncontrolled;
  const setOpen = onOpenChange ?? setUncontrolled;
  const percent = pane.summary.contextPercent;
  const label = percent === undefined
    ? 'Context usage unavailable'
    : `Context ${percent}% used`;
  const danger = percent !== undefined && percent >= DANGER_PERCENT;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={(
            <Button
              variant="ghost"
              size="xs"
              aria-label={label}
              onClick={() => setOpen(true)}
              // h-6, not the ring's own 14px: a 14px target is under the
              // floor for a control this panel expects to be clickable and
              // keyboard-reachable. In the danger state the label rides
              // alongside, so the width comes from the content instead.
              className={cn('ml-1 shrink-0', danger ? 'px-1' : 'w-6 px-0')}
            />
          )}
        >
          <Ring percent={percent} />
          {/*
            Above 80% the ring turns `destructive`, and colour on its own is
            not a signal — the same rule status-badge.tsx already follows.
            The percentage rides beside it only in that state, so the width
            is spent where it earns its place.
          */}
          {danger && (
            <span className="text-xs tabular-nums text-destructive">{percent}%</span>
          )}
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <ContextDialog pane={pane} open={open} onOpenChange={setOpen} />
    </>
  );
}
