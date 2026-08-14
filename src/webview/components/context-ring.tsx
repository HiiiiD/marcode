import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Ring } from './ring';
import { useStore } from '../store';
import type { PaneState } from '../reducer';
import type { ContextResult } from '../../protocol/messages';

/** Above this share of the window, colour alone stops carrying the signal. */
const DANGER_PERCENT = 80;

/** A provider reports a percentage; nothing guarantees it is one. */
function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** A listed file rounding to 0 is present but tiny — never "nothing". */
function formatPercent(percent: number): string {
  return percent === 0 ? '<1%' : `${percent}%`;
}

/**
 * `~/.claude/CLAUDE.md` and `./CLAUDE.md` are the common case, and the
 * basename alone renders them as two identical rows. Split so the parent can
 * be dimmed and dropped first.
 */
function splitPath(path: string): { dir: string; base: string } {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut < 0
    ? { dir: '', base: path }
    : { dir: path.slice(0, cut + 1), base: path.slice(cut + 1) };
}

function Row({
  label, percent, muted,
}: { label: string; percent: number; muted?: boolean }) {
  const value = clampPercent(percent);
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="w-24 shrink-0 truncate" title={label}>{label}</span>
      <span className="h-1.5 min-w-0 flex-1 rounded-full bg-muted">
        <span
          // `Free` is the absence of use: filling its bar with the accent
          // would say the opposite of what the row means.
          className={cn('block h-full rounded-full', muted ? 'bg-muted-foreground/40' : 'bg-primary')}
          style={{ width: `${value}%` }}
        />
      </span>
      <span className="w-9 shrink-0 text-right tabular-nums">{value}%</span>
    </div>
  );
}

function MemoryRow({
  path, percent, onOpenFile,
}: { path: string; percent: number; onOpenFile: (path: string) => void }) {
  const { dir, base } = splitPath(path);
  return (
    <div className="flex items-center gap-2 py-0.5">
      <Button
        variant="link"
        size="xs"
        className="h-auto min-w-0 flex-1 justify-start gap-0 px-0 pl-3 font-normal"
        title={path}
        onClick={() => onOpenFile(path)}
      >
        {dir && (
          // The basename is the identifying part, so it never shrinks and
          // the parent gives way first. `direction: rtl` puts the ellipsis
          // at the *start* of the parent, which is the end a path can lose;
          // the isolated `bdi` keeps the path itself reading left to right.
          <span className="min-w-0 truncate text-muted-foreground [direction:rtl]">
            <bdi dir="ltr">{dir}</bdi>
          </span>
        )}
        <span className="shrink-0">{base}</span>
      </Button>
      <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">
        {formatPercent(clampPercent(percent))}
      </span>
    </div>
  );
}

function Body({
  result, onOpenFile, onRetry,
}: {
  result: ContextResult | undefined;
  onOpenFile: (path: string) => void;
  onRetry: () => void;
}) {
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
    // Reopening the popover refetches, but that is an invisible recovery
    // path: the way out of the error state has to be on screen.
    return (
      <div className="flex items-baseline gap-2 py-1">
        <p className="min-w-0 flex-1 text-muted-foreground">{result.reason}</p>
        <Button
          variant="link"
          size="xs"
          className="h-auto shrink-0 px-0 font-normal"
          onClick={onRetry}
        >
          Retry
        </Button>
      </div>
    );
  }

  const b = result.breakdown;
  return (
    <div>
      <Row label="System prompt" percent={b.systemPercent} />
      <Row label="Memory" percent={b.memoryPercent} />
      {b.memoryFiles.length === 0 ? (
        <p className="py-0.5 pl-3 text-muted-foreground">No memory files loaded</p>
      ) : b.memoryFiles.map((file) => (
        <MemoryRow
          key={file.path}
          path={file.path}
          percent={file.percent}
          onOpenFile={onOpenFile}
        />
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
  const result = state.contextBySession[id];
  const danger = percent !== undefined && percent >= DANGER_PERCENT;

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
              // keyboard-reachable. In the danger state the label rides
              // alongside, so the width comes from the content instead.
              className={cn(
                'ml-1 inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-md hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                danger ? 'px-1' : 'w-6',
              )}
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
      {/*
        A 288px popover cannot fit a 300px pane once the positioner's own
        offsets are counted, so the width is a computation, not a token:
        clamp to the panel and cap at the comfortable reading width.
      */}
      <PopoverContent className="w-[calc(100vw-2rem)] max-w-72 text-xs">
        <div className="flex items-baseline justify-between border-b border-border pb-1">
          <span className="font-medium">Context</span>
          {/*
            Reads `percent` — the same pushed value the ring and its danger
            state use — rather than deriving its own number from the pulled
            breakdown below. The host refreshes `contextPercent` from the
            same fetch that serves the breakdown (see
            AgentSession.contextBreakdown), so this is never staler than the
            rows it sits above, and there is exactly one number in play.
          */}
          <span className={cn('tabular-nums text-muted-foreground', danger && 'text-destructive')}>
            {percent === undefined ? 'unavailable' : `${percent}% used`}
          </span>
        </div>
        <Body
          result={result}
          onOpenFile={(path) => post({ t: 'open-file', id, path })}
          onRetry={() => post({ t: 'request-context', id })}
        />
      </PopoverContent>
    </Popover>
  );
}
