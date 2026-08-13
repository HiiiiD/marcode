import { ColumnsIcon, RowsIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
          <ColumnsIcon aria-hidden />
          {open.size} of {state.sessions.length} in split
          {needing > 0 && (
            <span className="ml-auto text-primary" aria-live="polite">
              {needing} needs you
            </span>
          )}
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
        aria-label={`Split direction: ${horizontal ? 'side by side' : 'stacked'}`}
        aria-pressed={horizontal}
        disabled={narrow}
        title={narrow
          ? 'The panel is too narrow to split side by side; panes stack until it is wider.'
          : undefined}
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

      <SessionCreateMenu />
    </div>
  );
}
