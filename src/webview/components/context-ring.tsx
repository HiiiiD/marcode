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
              // Send's own size. The ring sits in the same addon row, and a
              // shorter control beside it reads as a misalignment rather
              // than as a smaller thing. In the danger state the percentage
              // rides alongside, so the height is held but the width comes
              // from the content.
              size={danger ? 'sm' : 'icon-sm'}
              aria-label={label}
              onClick={() => setOpen(true)}
              className={cn('ml-1 shrink-0', danger && 'px-1.5')}
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
