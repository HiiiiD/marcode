import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type TranscriptItemRole =
  | 'user' | 'assistant' | 'tool' | 'permission' | 'question' | 'subagent' | 'error';

/**
 * What the eye lands on before it can read anything. Two left rules that
 * differed only in hue at 40% opacity gave a scrolling reader nothing: the
 * user's turn and the agent's turn had the same silhouette, the same indent
 * and the same label treatment, and `bg-muted` on the user's text resolves to
 * within a percent of the sidebar background in most VS Code themes.
 *
 * So the split is structural. The user's turn is the only *contained* and the
 * only *indented* thing in the column — a ragged left edge that reads as
 * alternation at any scroll speed, in any theme, and without colour. The
 * agent's turn is uncontained prose flush to the column, because it is the
 * reading surface and a box around it would compete with the tool cards that
 * follow it.
 *
 * Everything else keeps a gutter rule, now 1px: above that a coloured rule
 * stops being a marker and becomes a bar.
 */
const FRAME: Record<TranscriptItemRole, string> = {
  user: cn(
    'rounded-lg px-3 py-2 text-sm',
    // Derived, not a token lookup: --muted is editorWidget-background, which
    // several themes set equal to the sidebar background. Mixing toward the
    // foreground guarantees the block separates from the column in light,
    // dark and high-contrast alike.
    'bg-[color-mix(in_oklch,var(--color-muted),var(--color-foreground)_7%)]',
  ),
  // The reading surface: more air above and below than the rows of tool activity around it, so the answer stands out from the machinery.
  assistant: 'text-sm text-foreground',
  tool: '',
  // Flat like the tool rows it sits among: a worker or a team is one more row of the work log, with no label, time or rule of its own.
  subagent: '',
  permission: 'border-l border-l-destructive pl-2',
  // No frame of its own: a live question is a full bordered card carrying the
  // `attention` tone, and a gutter rule beside it would be the same signal
  // said twice. The role exists so that card gets the label and timestamp
  // every other item has — it had neither — without inheriting a second
  // border.
  question: '',
  error: 'border-l border-l-destructive pl-2',
};

/**
 * One shell for every role: a label, the timestamp that lives on every
 * transcript item, and the frame that says whose turn this is.
 */
export function TranscriptItemShell({
  role, label, ts, children,
}: {
  role: TranscriptItemRole;
  /** Absent on the user's own turn: the filled block already says whose it is, so only a sender from another session is named. */
  label?: string;
  ts?: number;
  children: ReactNode;
}) {
  return (
    <div className={cn('group/item relative my-0', FRAME[role])}>
      {/* The agent's own prose carries no label: an uppercase name and time above every paragraph was chrome, not information. */}
      {role !== 'assistant' && role !== 'subagent' && label !== undefined && <div className="mb-0.5 flex items-baseline gap-2">
        <span
          className={cn(
            'text-[0.65rem] font-medium tracking-wide uppercase',
            // Inside the user's filled block the label sits on a lifted
            // surface and can carry a little more weight; elsewhere it stays
            // the quietest thing in the item.
            role === 'user' ? 'text-foreground/70' : 'text-muted-foreground',
          )}
        >
          {label}
        </span>
        {ts !== undefined && (
          <span
            className="text-[0.65rem] text-muted-foreground"
            title={new Date(ts).toLocaleString()}
          >
            {new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>}
      {children}
      {(role === 'assistant' || (role === 'user' && label === undefined)) && ts !== undefined && (
        <div className="mt-0.5 text-[0.65rem] text-muted-foreground tabular-nums" title={new Date(ts).toLocaleString()}>
          {new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
    </div>
  );
}
