import { useEffect, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PermissionCard } from './permission-card';
import { ToolCard } from './tool-card';
import { TranscriptItemShell } from './transcript-item-shell';
import {
  formatElapsed, subagentLabel, subagentStateLabel, summarizeSubagent, windowChildren,
} from './subagent-window';
import type { SessionId, TranscriptItem } from '../../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

export function SubagentCard({ item, sessionId }: { item: ToolItem; sessionId: SessionId }) {
  const [manuallyCollapsed, setManuallyCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // A collapsed card must still tick: a row reading "12 tools · 34s" is not
  // a hang, and a static row is. One interval per running card, cleared the
  // moment it settles — a settled card's elapsed comes from its last child,
  // so nothing needs to re-render after that.
  useEffect(() => {
    if (item.state !== 'running') { return; }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [item.state]);

  const summary = summarizeSubagent(item, now);
  const children = item.children ?? [];
  const shown = windowChildren(children);

  // A blocked subagent forces itself open — an approval buried in a
  // collapsed row would be worse than a flat transcript, where it was at
  // least visible. Once the user collapses it deliberately it stays
  // collapsed, and the header keeps reporting the block, so the card never
  // fights them.
  const expanded = open || (summary.blocked && !manuallyCollapsed);
  const panelId = `subagent-${item.toolId}`;

  return (
    <TranscriptItemShell role="subagent" label="Subagent" ts={item.ts}>
      <div className="rounded border border-border text-xs">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const next = !expanded;
            setOpen(next);
            if (!next) { setManuallyCollapsed(true); }
          }}
          aria-expanded={expanded}
          aria-controls={panelId}
          // Matches tool-card.tsx: override the size variant's gap/padding
          // and justification, never its height.
          className="flex w-full items-center justify-start gap-2 px-2 font-normal"
        >
          {expanded ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
          <span className="truncate font-medium">{subagentLabel(item)}</span>
          <span className="shrink-0 text-muted-foreground">
            {summary.toolCount} {summary.toolCount === 1 ? 'tool' : 'tools'}
            {' · '}{formatElapsed(summary.elapsedMs)}
          </span>
          {/*
            The visible state is carried by the chevron and, when blocked, by
            the chip below. Everything else gets a text equivalent here, for
            the same reason tool-card.tsx does: an icon-only state has no
            accessible name at all.
          */}
          <span className="sr-only">{subagentStateLabel(item, summary.blocked)}</span>
          {summary.blocked && (
            // The `attention` tone from status-badge.tsx, spelled the same
            // way: text plus a quiet fill, never colour alone. A subagent
            // blocked on the user says the same thing the session badge
            // says, so it must not look like a different kind of event.
            <span className="ml-auto shrink-0 rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-medium">
              Needs you
            </span>
          )}
        </Button>

        {expanded && (
          <div id={panelId} className="border-t border-border px-2 py-1">
            {children.length > shown.length && (
              // A statement of fact, not a control. "Show all" would dump
              // 200 rows into the transcript and undo the bound; the escape
              // hatch is a future subagent pane, not a button here.
              <p className="pb-1 text-muted-foreground">
                showing last {shown.length} of {children.length}
              </p>
            )}
            <div className={cn('flex flex-col gap-1')}>
              {shown.map((child) =>
                child.role === 'permission' ? (
                  <PermissionCard key={child.id} item={child} sessionId={sessionId} />
                ) : child.role === 'tool' ? (
                  <ToolCard key={child.id} item={child} />
                ) : null,
              )}
            </div>
          </div>
        )}
      </div>
    </TranscriptItemShell>
  );
}
