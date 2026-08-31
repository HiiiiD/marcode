// src/fleet/subagent-list.tsx
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { filterSubagents } from './filter-subagents';
import {
  formatElapsed, subagentLabel, subagentStateLabel, summarizeSubagent,
} from '../webview/components/subagent-window';
import type { PaneState } from '../webview/reducer';

/**
 * One session's subagents — running by default, `showSettled` reveals
 * finished/failed ones too. Each row's summary line is computed the same way
 * `SubagentCard`'s collapsed header is, so this list and the sidebar's
 * inline card never describe one subagent two different ways.
 */
export function SubagentList({
  pane, showSettled, onToggleSettled, onOpen, onBack,
}: {
  pane: PaneState;
  showSettled: boolean;
  onToggleSettled: () => void;
  onOpen: (itemId: string) => void;
  onBack: () => void;
}) {
  const subagents = filterSubagents(pane.items, { includeSettled: showSettled });
  const now = Date.now();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1 text-xs">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="h-6 gap-1 px-1 font-normal text-muted-foreground"
        >
          <ChevronLeftIcon aria-hidden className="size-3.5" />
          <span className="truncate">{pane.summary.title}</span>
        </Button>
        <Button
          variant={showSettled ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={showSettled}
          className="h-6 px-2 font-normal"
          onClick={onToggleSettled}
        >
          {showSettled ? 'Showing all' : 'Running only'}
        </Button>
      </div>
      {subagents.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">
          {showSettled ? 'No subagents yet.' : 'No subagents running right now.'}
        </div>
      ) : (
        <div className="flex flex-col gap-1 p-2">
          {subagents.map((item) => {
            const summary = summarizeSubagent(item, now);
            return (
              <Button
                key={item.id}
                variant="outline"
                className="flex h-auto w-full items-center justify-between gap-2 p-2 text-left text-xs font-normal"
                onClick={() => onOpen(item.id)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium">{subagentLabel(item)}</span>
                  <span className="sr-only">{subagentStateLabel(item, summary.blocked)}</span>
                  {summary.blocked && (
                    <span className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-medium">
                      Needs you
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {summary.toolCount} {summary.toolCount === 1 ? 'tool' : 'tools'}
                  {' · '}{formatElapsed(summary.elapsedMs)}
                </span>
                <ChevronRightIcon aria-hidden className="shrink-0 size-3.5 text-muted-foreground" />
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
