import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { evenlySizedPanes } from './pane-layout';
import { SessionCreateMenu } from './session-create-menu';
import { SessionRow } from './session-row';
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
            <SessionRow key={s.id} session={s} open={open.has(s.id)} onToggle={() => toggle(s.id)} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Toggle split orientation"
        className="shrink-0"
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

      <SessionCreateMenu />
    </div>
  );
}
