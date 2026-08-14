import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Ring } from './ring';
import { useStore } from '../store';
import type { PaneState } from '../reducer';
import type { ContextResult } from '../../protocol/messages';

/** A listed file rounding to 0 is present but tiny — never "nothing". */
function formatPercent(percent: number): string {
  return percent === 0 ? '<1%' : `${percent}%`;
}

function Row({
  label, percent, muted,
}: { label: string; percent: number; muted?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="w-24 shrink-0 truncate" title={label}>{label}</span>
      <span className="h-1.5 min-w-0 flex-1 rounded-full bg-muted">
        <span
          // `Free` is the absence of use: filling its bar with the accent
          // would say the opposite of what the row means.
          className={cn('block h-full rounded-full', muted ? 'bg-muted-foreground/40' : 'bg-primary')}
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </span>
      <span className="w-9 shrink-0 text-right tabular-nums">{percent}%</span>
    </div>
  );
}

function Body({
  result, onOpenFile,
}: { result: ContextResult | undefined; onOpenFile: (path: string) => void }) {
  if (!result) {
    return (
      <div className="space-y-1 py-1" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-3 animate-pulse rounded bg-muted" />
        ))}
      </div>
    );
  }

  if (!result.ok) {
    return <p className="py-1 text-muted-foreground">{result.reason}</p>;
  }

  const b = result.breakdown;
  return (
    <div>
      <Row label="System prompt" percent={b.systemPercent} />
      <Row label="Memory" percent={b.memoryPercent} />
      {b.memoryFiles.length === 0 ? (
        <p className="py-0.5 pl-3 text-muted-foreground">No memory files loaded</p>
      ) : b.memoryFiles.map((file) => (
        <div key={file.path} className="flex items-center gap-2 py-0.5">
          <Button
            variant="link"
            size="xs"
            className="h-auto min-w-0 flex-1 justify-start truncate px-0 pl-3 font-normal"
            title={file.path}
            onClick={() => onOpenFile(file.path)}
          >
            {file.path.split(/[\\/]/).pop()}
          </Button>
          <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">
            {formatPercent(file.percent)}
          </span>
        </div>
      ))}
      <Row label="Conversation" percent={b.conversationPercent} />
      <Row label="Free" percent={b.freePercent} muted />
    </div>
  );
}

export function ContextRing({ pane }: { pane: PaneState }) {
  const { state, post } = useStore();
  const [open, setOpen] = useState(false);
  const id = pane.summary.id;
  const percent = pane.summary.contextPercent;
  const label = percent === undefined
    ? 'Context usage unavailable'
    : `Context ${percent}% used`;

  return (
    <Popover
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        // Pulled, not pushed: the inventory is static-ish and must not ride
        // every transcript patch. Refetch on each open so a long-lived
        // session never shows a stale list.
        if (next) { post({ t: 'request-context', id }); }
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={(
            <PopoverTrigger
              aria-label={label}
              // size-6, not the ring's own 14px: a 14px target is under the
              // floor for a control this panel expects to be clickable and
              // keyboard-reachable.
              className="ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            />
          )}
        >
          <Ring percent={percent} />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      {/*
        A 288px popover cannot fit a 300px pane once the positioner's own
        offsets are counted, so the width is a computation, not a token:
        clamp to the panel and cap at the comfortable reading width.
      */}
      <PopoverContent className="w-[calc(100vw-2rem)] max-w-72 text-xs">
        <div className="flex items-baseline justify-between border-b border-border pb-1">
          <span className="font-medium">Context</span>
          <span
            className={cn(
              'tabular-nums text-muted-foreground',
              percent !== undefined && percent >= 80 && 'text-destructive',
            )}
          >
            {percent === undefined ? 'unavailable' : `${percent}% used`}
          </span>
        </div>
        <Body
          result={state.contextBySession[id]}
          onOpenFile={(path) => post({ t: 'open-file', path })}
        />
      </PopoverContent>
    </Popover>
  );
}
