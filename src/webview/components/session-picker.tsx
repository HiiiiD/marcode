import {
  ColumnsIcon, FolderGit2Icon, GitCompareIcon, PlugZapIcon, RowsIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { aggregateServers, isUnhealthy, worstState } from './mcp-status';
import { evenlySizedPanes } from './pane-layout';
import { REVIEW_TOGGLE_ATTR } from './review-toggle';
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
  /** Whether the panel is wide enough to offer the fleet diff surface at all
   * — see `REVIEW_PX` in `use-is-narrow.ts`. */
  canReview: boolean;
  /** Whether the fleet diff surface is currently showing — this control is a
   * toggle over the panel body, and it says so through `aria-pressed`. */
  reviewing: boolean;
  onReview: () => void;
}

export function SessionPicker({ narrow, canReview, reviewing, onReview }: SessionPickerProps) {
  const { state, post } = useStore();
  const open = new Set(state.layout.panes.map((p) => p.sessionId));
  const horizontal = state.layout.orientation === 'horizontal';
  const needing = state.sessions.filter((s) => statusView(s.status).needsUser).length;
  const servers = aggregateServers(state.byId);
  const worst = worstState(servers);
  const serversNeedAttention = worst !== undefined && isUnhealthy(worst);

  const setPanes = (ids: SessionId[]) => {
    post({ t: 'set-layout', layout: evenlySizedPanes(ids, state.layout.orientation) });
    post({ t: 'set-visible', sessionIds: ids });
  };

  const toggle = (id: SessionId) => {
    setPanes(open.has(id) ? [...open].filter((x) => x !== id) : [...open, id]);
  };

  const live = state.sessions.filter((s) => !s.archived);
  const archived = state.sessions.filter((s) => s.archived);

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
    <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" className="min-w-0 flex-1 justify-start" />}
        >
          <ColumnsIcon aria-hidden />
          {open.size} of {state.sessions.length} in split
          {needing > 0 ? (
            <span className="ml-auto text-primary">
              {needing} needs you
            </span>
          ) : serversNeedAttention && (
            // Only when something is actually wrong. Every server is
            // `pending` at startup and connected thereafter, so a permanent
            // health chip would spend the narrowest row in the app on a
            // value that is almost always "fine".
            <span className="ml-auto text-destructive">
              MCP: {worst === 'needs-auth' ? 'needs auth' : 'failed'}
            </span>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
          {state.sessions.length === 0 && (
            <DropdownMenuItem disabled>No sessions yet</DropdownMenuItem>
          )}
          {live.map((s) => (
            <SessionRow key={s.id} session={s} open={open.has(s.id)} onToggle={() => toggle(s.id)} />
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
                  <SessionRow key={s.id} session={s} open={open.has(s.id)} onToggle={() => toggle(s.id)} />
                ))}
              </DropdownMenuGroup>
            </>
          )}
          {servers.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>MCP servers (open sessions)</DropdownMenuLabel>
                {servers.map((server) => (
                  <DropdownMenuItem key={server.name} disabled className="flex-col items-start gap-0.5">
                    <span className="flex w-full items-center gap-2">
                      <PlugZapIcon aria-hidden />
                      <span className="truncate font-medium">{server.name}</span>
                      <span className={cn(
                        'ml-auto shrink-0',
                        isUnhealthy(server.state) ? 'text-destructive' : 'text-muted-foreground',
                      )}>
                        {server.state === 'needs-auth' ? 'needs auth' : server.state}
                      </span>
                    </span>
                    {server.toolCount !== undefined && (
                      <span className="text-muted-foreground">
                        {server.toolCount} {server.toolCount === 1 ? 'tool' : 'tools'}
                      </span>
                    )}
                    {server.state === 'needs-auth' && (
                      // No button: the extension host cannot run an OAuth
                      // flow, so a control here would be a lie. The honest
                      // action is a terminal one.
                      <span className="text-muted-foreground">
                        Authorize in a terminal, then reopen the session.
                      </span>
                    )}
                    {server.error && (
                      <span className="wrap-break-word text-destructive">{server.error}</span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/*
        Its own control, not an item in the menu above. That trigger says "in
        split" and the menu already answers three other questions; filing
        destructive filesystem management as a fourth, ungrouped entry inside
        it hides the one action in this panel that deletes a directory behind
        a word about layout. Mounted only when the sweep is non-empty, for the
        same reason the pane header's bring-back door is.
      */}
      {state.staleTrees.length > 0 && (
        <Button
          variant="outline"
          size="icon-sm"
          className="shrink-0"
          aria-label={`Working trees (${state.staleTrees.length}): review and remove the worktrees this panel still touches`}
          onClick={() => { setTreesOpen(true); }}
        >
          <FolderGit2Icon aria-hidden />
        </Button>
      )}

      {/*
        Its own control, beside the working-trees one, for the same reason
        that one is: the menu it sits next to answers questions about layout,
        and filing "what did the fleet write" inside it would hide the only
        surface that answers for the work itself behind a word about panes.

        Gated on width rather than styled small: a file list with churn
        counts and session chips in a 300px column is a wall of truncated
        paths, which is the failure this gate exists to prevent.
      */}
      {canReview && (
        <Button
          variant="outline"
          size="icon-sm"
          className="shrink-0"
          aria-label="Review changes: every file the fleet has changed"
          // It replaces the panel body rather than opening something beside
          // it, so it is a toggle, and a toggle that never says which way it
          // is set leaves a screen-reader user with no way to tell the
          // surface is already open. The same treatment the split-direction
          // button beside it gets.
          aria-pressed={reviewing}
          // Read back by `FleetDiff` on the way out: closing unmounts the
          // control that had focus, and this is where focus goes. See
          // `review-toggle.ts`.
          {...{ [REVIEW_TOGGLE_ATTR]: '' }}
          onClick={onReview}
        >
          <GitCompareIcon aria-hidden />
        </Button>
      )}

      {/* Mounted whether or not the button is: the last removal empties the
          sweep, and the dialog that is still open is where the user reads
          that it happened. Unmounting it here would close it instead. */}
      <StaleTreesDialog open={treesOpen} onOpenChange={setTreesOpen} />

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
      >
        {horizontal ? <ColumnsIcon aria-hidden /> : <RowsIcon aria-hidden />}
      </Button>
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
  );
}
