import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useStore } from '../store';
import type { PaneState } from '../reducer';
import type { ContextResult } from '../../protocol/messages';

/** Above this share of the window, colour alone stops carrying the signal. */
export const DANGER_PERCENT = 80;

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
      <div className="space-y-1.5 py-1" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          // `bg-muted` is the popover's own surface colour, so a skeleton
          // drawn in it is invisible against the panel it sits on and the
          // pending state reads as a broken empty box. The placeholder has
          // to be a shade the surface is not.
          <div key={i} className="h-3 animate-pulse rounded bg-muted-foreground/20" />
        ))}
      </div>
    );
  }

  if (!result.ok) {
    // Reopening the dialog refetches, but that is an invisible recovery
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

/**
 * The context inventory for one session. Two doors lead here — the ring in
 * the composer and the intercepted `/context` command — so the surface is
 * controlled by whoever owns those, and the fetch lives here rather than in
 * either door.
 */
export function ContextDialog({
  pane, open, onOpenChange,
}: { pane: PaneState; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { state, post } = useStore();
  const id = pane.summary.id;
  const result = state.contextBySession[id];
  // The ring is pushed at turn-end; the breakdown is pulled on open. Once a
  // reply has landed it is the fresher of the two, so the header quotes it —
  // otherwise the header and the body it sits above can disagree by a turn.
  const headerPercent = result?.ok
    ? clampPercent(100 - result.breakdown.freePercent)
    : pane.summary.contextPercent;

  // Pulled, not pushed: the inventory is static-ish and must not ride every
  // transcript patch. Refetched on each open so a long-lived session never
  // shows a stale list — and here rather than in the openers, so the two
  // doors cannot drift apart.
  useEffect(() => {
    if (open) { post({ t: 'request-context', id }); }
  }, [open, id, post]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 text-xs">
        <DialogHeader>
          <div className="flex items-baseline justify-between gap-2 border-b border-border pb-2">
            <DialogTitle className="text-sm">Context</DialogTitle>
            <span
              className={cn(
                'tabular-nums text-muted-foreground',
                headerPercent !== undefined && headerPercent >= DANGER_PERCENT && 'text-destructive',
              )}
            >
              {headerPercent === undefined ? 'unavailable' : `${headerPercent}% used`}
            </span>
          </div>
        </DialogHeader>
        <Body
          result={result}
          onOpenFile={(path) => post({ t: 'open-file', id, path })}
          onRetry={() => post({ t: 'request-context', id })}
        />
      </DialogContent>
    </Dialog>
  );
}
