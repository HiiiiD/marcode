import {
  ColumnsIcon, FolderGit2Icon, GitCompareIcon, LayersIcon, LayoutGridIcon, RowsIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { evenlySizedPanes } from './pane-layout';
import { SessionCreateMenu } from './session-create-menu';
import { SessionRow } from './session-row';
import { StaleTreesDialog } from './stale-trees';
import { useStore } from '../store';
import { statusView } from '../status';
import type { SessionId } from '../../protocol/messages';

interface SessionPickerProps {
  /** Whether the panel is too narrow to split side by side. Measured once,
   * in `App`, and shared with `PaneGroup` — see `use-is-narrow.ts`. */
  narrow: boolean;
  onReview: () => void;
  onFleet: () => void;
}

export function SessionPicker({ narrow, onReview, onFleet }: SessionPickerProps) {
  const { state, post } = useStore();
  const open = new Set(state.layout.panes.map((p) => p.sessionId));
  const horizontal = state.layout.orientation === 'horizontal';
  const needing = state.sessions.filter((s) => statusView(s.status).needsUser).length;

  const setPanes = (ids: SessionId[]) => {
    post({ t: 'set-layout', layout: evenlySizedPanes(ids, state.layout.orientation) });
    post({ t: 'set-visible', sessionIds: ids });
  };

  const toggle = (id: SessionId) => {
    setPanes(open.has(id) ? [...open].filter((x) => x !== id) : [...open, id]);
  };

  const live = state.sessions.filter((s) => !s.archived);
  const archived = state.sessions.filter((s) => s.archived);

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
      <DropdownMenu>
        <Tooltip>
        <TooltipTrigger
          render={(
            <DropdownMenuTrigger
              // `size="sm"` rather than a fixed `icon-sm`: this trigger is
              // icon-only most of the time but still has to make room for
              // the "N needs you" badge, and `icon-sm` is a fixed square
              // that clips overflow text (see the same choice on the MCP
              // trigger below). `sm`'s auto width keeps the icon-only state
              // close to the row's other icon buttons and only widens when
              // it actually has something to say.
              render={<Button variant="outline" size="sm" className="min-w-0 shrink-0" />}
            />
          )}
        >
          {/*
            A distinct glyph, not `ColumnsIcon` — that icon is reserved for
            the orientation toggle a few controls to the right (`Columns`
            for side-by-side, `Rows` for stacked). Reusing it here for an
            unrelated concept let two controls in the same row share one
            icon.
          */}
          <LayersIcon aria-hidden />
          {/*
            No visible label beyond the icon in the common case: the roster
            of open panes is visible in the split itself, so restating it
            here as "X of Y in split" only repeated what the panel already
            shows. What isn't otherwise visible is whether anything here
            needs the user — that stays, and is the only thing that widens
            this control.
          */}
          <span className="sr-only">Manage which sessions are shown</span>
          {needing > 0 && (
            <span className="text-primary">
              {needing} needs you
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent>Manage which sessions are shown</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
          {state.sessions.length === 0 && (
            <DropdownMenuItem disabled>No sessions yet</DropdownMenuItem>
          )}
          {live.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              open={open.has(s.id)}
              onToggle={() => toggle(s.id)}
            />
          ))}
          {archived.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {/*
                `DropdownMenuLabel` renders Base UI's `Menu.GroupLabel`,
                which calls `useMenuGroupRootContext()` and throws without a
                `Menu.Group` ancestor — so the label and the archived rows it
                names are wrapped in one `DropdownMenuGroup` rather than the
                label standing alone.
              */}
              <DropdownMenuGroup>
                <DropdownMenuLabel>{`Archived (${archived.length})`}</DropdownMenuLabel>
                {archived.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    open={open.has(s.id)}
                    onToggle={() => toggle(s.id)}
                  />
                ))}
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/*
        Everything past the roster trigger groups on the row's other edge:
        `justify-between` on the row now that neither side fills the middle
        with a stretched control, so the two ends anchor to the panel's
        corners instead of leaving one dead gap wherever the shorter side
        happens to end.
      */}
      <div className="flex items-center gap-2">

      {/*
        Its own control, not an item in the menu above. That trigger only
        manages which sessions are shown and the menu already answers three
        other questions; filing destructive filesystem management as a
        fourth, ungrouped entry inside it hides the one action in this panel
        that deletes a directory behind a word about layout. Mounted only
        when the sweep is non-empty, for the same reason the pane header's
        bring-back door is.
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
        that one is: the menu it sits next to answers questions about layout,
        and filing "what did the fleet write" inside it would hide the only
        surface that answers for the work itself behind a word about panes.

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
            disabled={narrow}
            // A `title` on a disabled button is reachable by neither keyboard
            // focus nor most screen readers — disabled elements are pulled out
            // of both. `aria-describedby` plus real, rendered (if visually
            // hidden) text is the same remedy as the composer's disabled bypass
            // option.
            aria-describedby={narrow ? 'orientation-reason' : undefined}
            className="shrink-0"
            onClick={() => post({
              t: 'set-layout',
              layout: {
                ...state.layout,
                orientation: state.layout.orientation === 'vertical' ? 'horizontal' : 'vertical',
              },
            })}
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

      <SessionCreateMenu />
      </div>
    </div>
  );
}
