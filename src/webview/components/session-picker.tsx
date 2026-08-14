import { ColumnsIcon, PlugZapIcon, RowsIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { aggregateServers, isUnhealthy, worstState } from './mcp-status';
import { evenlySizedPanes } from './pane-layout';
import { SessionCreateMenu } from './session-create-menu';
import { SessionRow } from './session-row';
import { useStore } from '../store';
import { statusView } from '../status';
import type { SessionId } from '../../protocol/messages';

interface SessionPickerProps {
  /** Whether the panel is too narrow to split side by side. Measured once,
   * in `App`, and shared with `PaneGroup` — see `use-is-narrow.ts`. */
  narrow: boolean;
}

export function SessionPicker({ narrow }: SessionPickerProps) {
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
