// src/fleet/subagent-list.tsx
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { filterSubagents } from './filter-subagents';
import {
  formatElapsed, isBackgroundDispatch, subagentLabel, subagentStateLabel, summarizeSubagent,
} from '../webview/components/subagent-window';
import type { PaneState } from '../webview/reducer';

/**
 * One session's subagents — running by default, `showSettled` reveals
 * finished/failed ones too. Each row's summary line is computed the same way
 * `SubagentCard`'s collapsed header is, so this list and the sidebar's
 * inline card never describe one subagent two different ways.
 *
 * The header is two rows, not one: a breadcrumb (where you are) and a status
 * line (what you're looking at, and the one control that changes it). Fusing
 * them into a single flex row reads as one cramped sentence at 300px — this
 * gives each its own line and its own job, the same split `SessionHeader`
 * uses for title vs. status elsewhere in the panel.
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
      <div className="flex flex-col gap-1 border-b border-border pb-1.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="h-7 w-full justify-start gap-1 px-1.5 font-normal text-muted-foreground"
        >
          <ChevronLeftIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate text-foreground">{pane.summary.title}</span>
        </Button>
        <div className="flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground">
          <span>
            {subagents.length} {subagents.length === 1 ? 'subagent' : 'subagents'}
          </span>
          <label className="flex items-center gap-1.5">
            <span>Show finished</span>
            <Switch
              checked={showSettled}
              onCheckedChange={onToggleSettled}
              className="h-4 w-7"
            />
          </label>
        </div>
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
                className="flex h-auto w-full flex-col items-stretch gap-1 p-2 text-left text-xs font-normal"
                onClick={() => onOpen(item.id)}
              >
                <span className="flex min-w-0 items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{subagentLabel(item)}</span>
                    <span className="sr-only">{subagentStateLabel(item, summary.blocked)}</span>
                    {summary.blocked && (
                      <span
                        className={cn(
                          'shrink-0 rounded-full border border-primary/40',
                          'bg-primary/10 px-1.5 py-0.5 font-medium text-foreground',
                        )}
                      >
                        Needs you
                      </span>
                    )}
                  </span>
                  <ChevronRightIcon aria-hidden className="shrink-0 size-3.5 text-muted-foreground" />
                </span>
                <span className="text-muted-foreground">
                  {isBackgroundDispatch(item) ? (
                    // Same reasoning as SubagentCard's header: this dispatch
                    // never gains nested children, so "0 tools · 0s" would
                    // misread as stuck rather than "running elsewhere."
                    'Running in background'
                  ) : (
                    <>
                      {summary.toolCount} {summary.toolCount === 1 ? 'tool' : 'tools'}
                      {' · '}{formatElapsed(summary.elapsedMs)}
                    </>
                  )}
                </span>
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
