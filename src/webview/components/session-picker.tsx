import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { evenlySizedPanes } from './pane-layout';
import { useStore } from '../store';
import type { SessionId } from '../../protocol/messages';

export function SessionPicker() {
  const { state, post } = useStore();
  const open = new Set(state.layout.panes.map((p) => p.sessionId));

  const setPanes = (ids: SessionId[]) => {
    post({ t: 'set-layout', layout: evenlySizedPanes(ids, state.layout.orientation) });
    post({ t: 'set-visible', sessionIds: ids });
  };

  const toggle = (id: SessionId) => {
    setPanes(open.has(id) ? [...open].filter((x) => x !== id) : [...open, id]);
  };

  const providerId = state.catalog[0]?.id;

  return (
    <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" className="min-w-0 flex-1 justify-start" />}
        >
          Sessions ({open.size}/{state.sessions.length})
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
          {state.sessions.length === 0 && (
            <DropdownMenuItem disabled>No sessions yet</DropdownMenuItem>
          )}
          {state.sessions.map((s) => (
            <DropdownMenuCheckboxItem
              key={s.id}
              checked={open.has(s.id)}
              onCheckedChange={() => toggle(s.id)}
            >
              <span className="truncate">{s.title}</span>
              {s.archived && (
                <span className="ml-auto pl-2 text-muted-foreground">archived</span>
              )}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          {state.sessions.map((s) => (
            <DropdownMenuItem
              key={`del-${s.id}`}
              variant="destructive"
              aria-label={`Delete session ${s.title}`}
              onClick={() => post({ t: 'delete-session', id: s.id })}
            >
              Delete “{s.title}”
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="outline"
        size="icon"
        aria-label="Toggle split orientation"
        className="h-7 w-7 shrink-0"
        onClick={() => post({
          t: 'set-layout',
          layout: {
            ...state.layout,
            orientation: state.layout.orientation === 'vertical' ? 'horizontal' : 'vertical',
          },
        })}
      >
        {state.layout.orientation === 'vertical' ? '⬍' : '⬌'}
      </Button>

      <Button
        size="sm"
        className="shrink-0"
        disabled={!providerId}
        onClick={() => providerId && post({ t: 'create-session', providerId, cwd: '' })}
      >
        + New
      </Button>
    </div>
  );
}
