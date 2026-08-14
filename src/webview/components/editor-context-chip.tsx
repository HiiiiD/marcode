import { cn } from '@/lib/utils';
import type { EditorContext } from '../../protocol/messages';

/**
 * `:60-73 +2`, or `''` when there is no selection at all. A colon is only
 * ever earned by a real line span — nothing else in this module is allowed
 * to glue one on, so any consumer that wants "no colon unless there is a
 * selection" gets that for free by using this instead of hand-rolling it.
 */
export function lineSpan(ctx: EditorContext): string {
  const ranges = ctx.selection?.ranges ?? [];
  const [first] = ranges;
  if (!first) { return ''; }
  const span = first.startLine === first.endLine
    ? `${first.startLine}`
    : `${first.startLine}-${first.endLine}`;
  const extra = ranges.length > 1 ? ` +${ranges.length - 1}` : '';
  return `:${span}${extra}`;
}

/**
 * What the user reads: the file's basename, the first range's line span, and
 * a count of any further ranges. The full path lives in `title` rather than
 * the label — a pane can be 150px wide, and the basename is what identifies
 * the file.
 */
export function chipLabel(ctx: EditorContext): string {
  return `${basename(ctx)}${lineSpan(ctx)}`;
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
  const span = lineSpan(ctx);

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
        'hover:text-foreground',
        // A real `outline`, not just a ring: forced-colors mode strips
        // box-shadows (what the ring utilities render as), and this chip has
        // no border to fall back on the way `Button` does with
        // `focus-visible:border-ring`. `outline-offset` keeps it off the
        // underlined text itself.
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      )}
    >
      <EditorContextLabel ctx={ctx} />
    </button>
  );
}
