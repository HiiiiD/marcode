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
 * Token counts, at the one place they are quoted.
 *
 * Thousands, one decimal, and never a bare digit group: 258400 read as a
 * count is a number to parse, `258.4k` is a magnitude to recognise, and
 * recognising which window a session is on is the whole reason the figure is
 * here. Under 1000 stays exact, because "0.9k" is a rounding of something the
 * reader could simply have been told.
 */
function formatTokens(tokens: number): string {
  if (tokens < 1000) { return String(Math.round(tokens)); }
  const thousands = tokens / 1000;
  // 45.2k below a hundred thousand, 258k above it: past three digits the
  // decimal is precision nobody acts on, and it costs a character in a
  // column that is 300px wide.
  return thousands >= 100 ? `${Math.round(thousands)}k` : `${(Math.round(thousands * 10) / 10)}k`;
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

/**
 * The three used slices, densest first, plus the track that stands for the
 * free remainder.
 *
 * One hue at three strengths rather than three hues: the panel inherits the
 * user's VS Code theme, and a palette of its own would read as a guest in it.
 * The order is fixed, so the tint doubles as the row's key.
 */
const SLICE_FILL = {
  system: 'bg-primary',
  memory: 'bg-primary/60',
  conversation: 'bg-primary/30',
  free: 'bg-muted-foreground/25',
} as const;

type SliceKey = keyof typeof SLICE_FILL;

/**
 * The window as a single 100% track, because these four numbers are parts of
 * one whole. Four independent 0–100 bars said the opposite, and at the
 * everyday values — 2%, 0%, 2%, 96% — three of them rendered as an empty
 * groove beside one full one, which is noise where a shape should be.
 */
function StackedBar({ slices }: { slices: { key: SliceKey; percent: number }[] }) {
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
      {slices.map(({ key, percent }) => (
        <span
          key={key}
          className={SLICE_FILL[key]}
          // A slice under about half a percent rounds to nothing at this
          // width. It is present, so it gets the thinnest mark that still
          // reads as one — being a hair wide than true beats vanishing.
          style={{ width: `${percent}%`, minWidth: percent > 0 ? '2px' : undefined }}
        />
      ))}
    </div>
  );
}

function Row({
  slice, label, percent,
}: { slice: SliceKey; label: string; percent: number }) {
  const value = clampPercent(percent);
  return (
    <div className="flex items-center gap-2 py-1">
      {/* Centered, not baseline-aligned: the swatch has no text in it, so a
          baseline is inferred from its box edge and lands a pixel or two off
          the label it keys. */}
      <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-xs', SLICE_FILL[slice])} />
      <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
      <span
        className={cn(
          'shrink-0 tabular-nums',
          slice === 'free' ? 'text-muted-foreground' : undefined,
        )}
      >
        {value}%
      </span>
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
        // pl-4 lines the filename up with the labels beside their swatches,
        // so the files read as belonging to the Memory row above them.
        // `shrink` overrides the Button base's own `shrink-0` — a different
        // twMerge group from `flex-1`, so the two don't dedupe on their own —
        // and without it a long path's dir never gives way and the row
        // spills past the dialog's edge instead of truncating.
        className="h-auto min-w-0 flex-1 shrink justify-start gap-0 px-0 pl-4 font-normal"
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
      <span className="shrink-0 tabular-nums text-muted-foreground">
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
  const tokens = b.usedTokens !== undefined && b.windowTokens !== undefined
    ? `${formatTokens(b.usedTokens)} of ${formatTokens(b.windowTokens)} tokens`
    : undefined;
  return (
    // min-w-0: DialogContent is a grid, and a grid item's default min-width
    // is content-based (`auto`), not 0. Without this a long memory path's
    // min-content width wins and the row spills past the dialog's capped
    // width instead of ever reaching the flex truncation below.
    <div className="min-w-0 space-y-3">
      <div className="space-y-1.5">
        <StackedBar
          slices={[
            { key: 'system', percent: clampPercent(b.systemPercent) },
            { key: 'memory', percent: clampPercent(b.memoryPercent) },
            { key: 'conversation', percent: clampPercent(b.conversationPercent) },
            { key: 'free', percent: clampPercent(b.freePercent) },
          ]}
        />
        {/* Under the bar, not in the header: the percentages are the reading,
            and this names the window they are percentages *of* — which is
            what tells a 17% session on a 258k window apart from one on 1M.
            Tied to the bar's own spacing so it reads as that bar's caption
            rather than as a fifth row of the list below. */}
        {tokens && (
          <p className="text-right tabular-nums text-muted-foreground">{tokens}</p>
        )}
      </div>
      <div>
        <Row slice="system" label="System prompt" percent={b.systemPercent} />
        <Row slice="memory" label="Memory" percent={b.memoryPercent} />
        {b.memoryFiles.length === 0 ? (
          <p className="py-0.5 pl-4 text-muted-foreground">No memory files loaded</p>
        ) : b.memoryFiles.map((file) => (
          <MemoryRow
            key={file.path}
            path={file.path}
            percent={file.percent}
            onOpenFile={onOpenFile}
          />
        ))}
        <Row slice="conversation" label="Conversation" percent={b.conversationPercent} />
        <Row slice="free" label="Free" percent={b.freePercent} />
      </div>
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
  // The same pushed value the ring and its danger state read, not a second
  // number derived from the pulled breakdown below. Serving a breakdown
  // refreshes `contextPercent` from that same fetch (see
  // AgentSession.contextBreakdown), so this is never staler than the body it
  // sits above — and there is one number in play rather than two that can
  // disagree, which is how a destructive 86% ring ended up beside a
  // "50% used" header.
  const headerPercent = pane.summary.contextPercent;

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
          {/* pr-7 clears the close button, which is positioned over this
              row's top-right corner. Without it the reading — the one number
              the header exists to give — sits under the X. */}
          <div className="flex items-baseline justify-between gap-2 border-b border-border pr-7 pb-2">
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
