import {
  ColumnsIcon, FolderGit2Icon, GitCompareIcon, HistoryIcon, LayoutGridIcon, RowsIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LayoutPresetsMenu } from './layout-presets-menu';
import { SessionCreateMenu } from './session-create-menu';
import { StaleTreesDialog } from './stale-trees';
import { useStore } from '../store';
import { statusView } from '../status';

interface SessionPickerProps {
  /** Whether the panel is too narrow to split side by side. Measured once,
   * in `App`, and shared with `PaneGroup` — see `use-is-narrow.ts`. */
  narrow: boolean;
  onReview: () => void;
  onFleet: () => void;
  onHistory: () => void;
}

const historyLabel = 'Browse session history in an editor tab';

export function SessionPicker({ narrow, onReview, onFleet, onHistory }: SessionPickerProps) {
  const { state, post } = useStore();
  const root = state.layout.root;
  const horizontal = root.kind === 'split' && root.orientation === 'horizontal';
  const needing = state.sessions.filter((s) => statusView(s.status).needsUser).length;

  // One string for both `aria-label` and the tooltip below — a sighted
  // hover and a screen reader hear the same thing, rather than the tooltip
  // trimming the destination a keyboard/screen-reader user still gets in
  // full.
  const workingTreesLabel =
    `Working trees (${state.staleTrees.length}): review and remove the worktrees this panel still touches`;

  const [treesOpen, setTreesOpen] = useState(false);
  // Asked once per set of directories the roster occupies, and never for an
  // empty roster: with no session there is nothing that could have left a
  // tree behind, and the sweep shells out to git per directory. The entry
  // point below is mounted only once an answer names one — an item that is
  // empty nine times out of ten teaches the user it is empty.
  const cwdKey = JSON.stringify(state.sessions.map((s) => s.cwd));
  useEffect(() => {
    if (cwdKey === '[]') { return; }
    post({ t: 'request-stale-trees' });
  }, [cwdKey, post]);

  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1 text-xs">
      <Tooltip>
        <TooltipTrigger
          render={(
            <Button
              variant="outline"
              size="sm"
              className="min-w-0 shrink-0"
              aria-label={historyLabel}
              onClick={onHistory}
            />
          )}
        >
          <HistoryIcon aria-hidden />
          {/* The count survives the move off the old roster trigger: whether
              anything needs the user is the one fact this row must keep
              surfacing, and it is what widens the control. */}
          {needing > 0 && (
            <span className="text-primary">
              {needing} needs you
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent>{historyLabel}</TooltipContent>
      </Tooltip>

      {/*
        Everything past the roster trigger groups on the row's other edge:
        `justify-between` on the row now that neither side fills the middle
        with a stretched control, so the two ends anchor to the panel's
        corners instead of leaving one dead gap wherever the shorter side
        happens to end.
      */}
      <div className="flex items-center gap-2">

      {/*
        Its own control: destructive filesystem management filed inside
        another control would hide the one action in this panel that deletes
        a directory behind a word about something else. Mounted only when the
        sweep is non-empty, for the same reason the pane header's bring-back
        door is.
      */}
      {state.staleTrees.length > 0 && (
        <Tooltip>
        <TooltipTrigger
          render={(
            <Button
              variant="outline"
              size="icon-sm"
              className="shrink-0"
              aria-label={workingTreesLabel}
              onClick={() => { setTreesOpen(true); }}
            />
          )}
        >
          <FolderGit2Icon aria-hidden />
        </TooltipTrigger>
        <TooltipContent>{workingTreesLabel}</TooltipContent>
        </Tooltip>
      )}

      {/*
        Its own control, beside the working-trees one, for the same reason
        that one is: "what did the fleet write" is the only surface that
        answers for the work itself, and filing it inside another control
        would hide it behind a word about something else.

        Always enabled: the surface it opens is an editor tab, not a panel
        takeover, so there is no panel width it could fail to fit in.
      */}
      <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            variant="outline"
            size="icon-sm"
            className="shrink-0"
            aria-label="Review fleet changes in an editor tab"
            onClick={onReview}
          />
        )}
      >
        <GitCompareIcon aria-hidden />
      </TooltipTrigger>
      <TooltipContent>Review fleet changes in an editor tab</TooltipContent>
      </Tooltip>

      {/*
        Its own control, beside the review one, for the same reason that one
        is: this opens the fleet-wide status view — every roster session's
        live status and activity, in an editor tab — a different surface than
        review's diff, and filing it inside another control's menu would hide
        it behind a word that names neither.
      */}
      <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            variant="outline"
            size="icon-sm"
            className="shrink-0"
            aria-label="Open the fleet view in an editor tab"
            onClick={onFleet}
          />
        )}
      >
        <LayoutGridIcon aria-hidden />
      </TooltipTrigger>
      <TooltipContent>Open the fleet view in an editor tab</TooltipContent>
      </Tooltip>

      {/* Mounted whether or not the button is: the last removal empties the
          sweep, and the dialog that is still open is where the user reads
          that it happened. Unmounting it here would close it instead. */}
      <StaleTreesDialog open={treesOpen} onOpenChange={setTreesOpen} />

      <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={`Split direction: ${horizontal ? 'side by side' : 'stacked'}`}
            aria-pressed={horizontal}
            disabled={narrow || root.kind !== 'split'}
            // A `title` on a disabled button is reachable by neither keyboard
            // focus nor most screen readers — disabled elements are pulled out
            // of both. `aria-describedby` plus real, rendered (if visually
            // hidden) text is the same remedy as the composer's disabled bypass
            // option. Both reasons can hold at once (a narrow panel with only
            // one pane open), so this points at whichever apply.
            aria-describedby={
              [narrow && 'orientation-reason', root.kind !== 'split' && 'orientation-single-pane-reason']
                .filter((id): id is string => Boolean(id))
                .join(' ') || undefined
            }
            className="shrink-0"
            onClick={() => {
              if (root.kind !== 'split') { return; }
              post({
                t: 'set-layout',
                layout: {
                  ...state.layout,
                  root: { ...root, orientation: root.orientation === 'vertical' ? 'horizontal' : 'vertical' },
                },
              });
            }}
          />
        )}
      >
        {horizontal ? <ColumnsIcon aria-hidden /> : <RowsIcon aria-hidden />}
      </TooltipTrigger>
      <TooltipContent>{`Split direction: ${horizontal ? 'side by side' : 'stacked'}`}</TooltipContent>
      </Tooltip>
      {narrow && (
        // sr-only rather than visible: at the width where this applies,
        // there is no room for a sentence in the toolbar, and the control is
        // already visibly disabled.
        <span id="orientation-reason" className="sr-only">
          The panel is too narrow to split side by side; panes stack until it is wider.
        </span>
      )}
      {root.kind !== 'split' && (
        <span id="orientation-single-pane-reason" className="sr-only">
          There's only one pane open; there's nothing to reorient yet.
        </span>
      )}

      <LayoutPresetsMenu />

      <SessionCreateMenu />
      </div>
    </div>
  );
}
