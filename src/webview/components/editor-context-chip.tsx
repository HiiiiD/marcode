import { cn } from '@/lib/utils';
import type { EditorContext } from '../../protocol/messages';

/**
 * What the user reads: the file's basename, the first range's line span, and
 * a count of any further ranges. The full path lives in `title` rather than
 * the label — a pane can be 150px wide, and the basename is what identifies
 * the file.
 */
export function chipLabel(ctx: EditorContext): string {
  const ranges = ctx.selection?.ranges ?? [];
  if (ranges.length === 0) { return basename(ctx); }
  const [first] = ranges;
  const span = first.startLine === first.endLine
    ? `${first.startLine}`
    : `${first.startLine}-${first.endLine}`;
  const extra = ranges.length > 1 ? ` +${ranges.length - 1}` : '';
  return `${basename(ctx)}:${span}${extra}`;
}

export function contextTitle(ctx: EditorContext): string {
  return ctx.selection?.truncated ? `${ctx.path} (truncated)` : ctx.path;
}

function basename(ctx: EditorContext): string {
  return ctx.path.split('/').pop() ?? ctx.path;
}

/**
 * Two spans, not one string: the basename truncates and the line span never
 * does. `:60-73 +2` is the part that differs between two messages about the
 * same file, so it is the part that must survive a narrow pane.
 */
export function EditorContextLabel({ ctx, className }: {
  ctx: EditorContext;
  className?: string;
}) {
  const ranges = ctx.selection?.ranges ?? [];
  const [first] = ranges;
  const span = first
    ? `:${first.startLine === first.endLine ? first.startLine : `${first.startLine}-${first.endLine}`}`
      + (ranges.length > 1 ? ` +${ranges.length - 1}` : '')
    : '';

  return (
    <span className={cn('flex min-w-0 items-baseline', className)}>
      <span className="truncate">{basename(ctx)}</span>
      {span && <span className="shrink-0">{span}</span>}
    </span>
  );
}

/**
 * The transcript's record of what a message carried. A link, not a Button:
 * it sits inline above a message body, and a Button variant's padding and
 * background would break that line's flow. It is still a real `<button>` —
 * keyboard reachable, with the focus ring the theme provides.
 */
export function EditorContextChip({ ctx, onClick }: {
  ctx: EditorContext;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={contextTitle(ctx)}
      aria-label={`Open ${chipLabel(ctx)}`}
      className={cn(
        'flex max-w-full items-baseline text-xs text-muted-foreground',
        'underline decoration-dotted underline-offset-2',
        'hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
      )}
    >
      <EditorContextLabel ctx={ctx} />
    </button>
  );
}
