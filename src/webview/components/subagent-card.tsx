import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger,
} from '@/components/ui/trace';
import { cn } from '@/lib/utils';
import { ChevronRightIcon } from 'lucide-react';
import { PermissionCard } from './permission-card';
import { QuestionCard } from './question-card';
import { ToolCard } from './tool-card';
import { ProviderStack, type MemberState } from './provider-stack';
import { TranscriptItemShell } from './transcript-item-shell';
import {
  formatElapsed, isBackgroundDispatch, subagentLabel, subagentStateLabel, summarizeSubagent,
  windowChildren,
} from '../../client-core/subagent-window';
import { useStore } from '../store';
import { useNestedMessages } from './nested-messages-context';
import { WorkerMessageRow } from './worker-message-row';
import { quietFor, STATUS_TONE, statusWords, WorkerActions, WorkerNotes, workerState, WorkerMessageBox } from './worker-controls';
import { activitySignature, QUIET_AFTER_MS, useLastChange } from '../lib/last-change';
import { expandedDisplayName, findModel } from '../../shared/model-catalog';
import { useOpenSubagentTranscript } from './subagent-drill-in-context';
import type { SessionId, TranscriptItem } from '../../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

export function memberState(item: ToolItem, blocked: boolean, now: number, changedAt: number): MemberState {
  if (blocked) { return 'blocked'; }
  if (item.state === 'running' && quietFor(item, now, changedAt) >= QUIET_AFTER_MS) { return 'quiet'; }
  return item.state === 'running' ? 'running' : item.state === 'ok' ? 'done' : 'failed';
}

export function SubagentCard({
  item, sessionId, embedded = false,
}: { item: ToolItem; sessionId: SessionId; embedded?: boolean }) {
  const [manuallyCollapsed, setManuallyCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const [messaging, setMessaging] = useState(false);
  const [sent, setSent] = useState<string[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const changedAt = useLastChange(activitySignature(item));
  const openTranscript = useOpenSubagentTranscript();
  const { post, state } = useStore();
  const hostedId = item.tool.kind === 'subagent' ? item.tool.childSessionId : undefined;

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
  const messages = useNestedMessages(hostedId);
  const timeline = [
    ...shown.map((child) => ({ ts: child.ts, child })),
    ...messages.map((message) => ({ ts: message.ts, message })),
  ].sort((a, b) => a.ts - b.ts);

  // A blocked subagent forces itself open — an approval buried in a
  // collapsed row would be worse than a flat transcript, where it was at
  // least visible. Once the user collapses it deliberately it stays
  // collapsed, and the header keeps reporting the block, so the card never
  // fights them.
  const wstate = hostedId ? workerState(item, summary.blocked, now, changedAt) : undefined;
  // A worker that failed or went quiet opens itself so the reason is not behind a click; a deliberate collapse still wins.
  const attention = summary.blocked || wstate === 'failed' || wstate === 'quiet';
  const expanded = open || (attention && !manuallyCollapsed);

  const hosted = item.tool.kind === 'subagent' && item.tool.provider !== undefined;
  const rawModel = item.tool.kind === 'subagent' ? item.tool.model : undefined;
  const row = rawModel === undefined ? undefined
    : findModel(state.catalog.find((p) => p.id === (item.tool.kind === 'subagent' ? item.tool.provider : undefined))?.models ?? [], rawModel);
  const modelName = row ? expandedDisplayName(row) : rawModel;
  const changeOpen = (next: boolean) => {
          setOpen(next);
          // Only a collapse that actually overrides a force-open (i.e. the
          // card is blocked right now) should suppress future force-opens.
          // Collapsing an unblocked running card is just tidying up and
          // must not silence a permission that arrives later.
          if (!next && attention) { setManuallyCollapsed(true); }
  };
  const card = (
      <TraceCollapsible
        bare
        className="group/item @container my-0"
        open={expanded}
        onOpenChange={changeOpen}
      >
        <div className="flex items-center">
        <TraceCollapsibleTrigger className={cn('h-7 min-w-0 flex-1 px-0 text-xs hover:bg-transparent [&>[data-slot=trace-icon]:last-child]:opacity-40 group-hover/item:[&>[data-slot=trace-icon]:last-child]:opacity-100 focus-visible:[&>[data-slot=trace-icon]:last-child]:opacity-100 aria-expanded:[&>[data-slot=trace-icon]:last-child]:opacity-100', hostedId && '[&>[data-slot=trace-icon]:last-child]:hidden')}>
          {hosted && item.tool.kind === 'subagent' && (
            <ProviderStack className="ml-1" members={[{
              providerId: item.tool.provider, name: subagentLabel(item), state: memberState(item, summary.blocked, now, changedAt),
            }]} />
          )}
          <span className={cn('font-medium', wstate ? 'max-w-[60%] shrink-0 truncate' : 'truncate')}>{subagentLabel(item)}</span>
          {wstate ? (
            // A hosted worker's header is its name and how it is doing; the counts and clocks live nowhere because a dot and a word say more.
            <>
              <span className={cn('shrink-0 text-xs font-medium', STATUS_TONE[wstate])}>{statusWords(wstate, quietFor(item, now, changedAt))}</span>
              {/* Only when the row has room to spare: the counts are nice to have, never worth crowding the name and the status. */}
              <span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums @[40rem]:inline">
                {summary.toolCount} {summary.toolCount === 1 ? 'tool' : 'tools'} · {formatElapsed(summary.elapsedMs)}
              </span>
              {modelName && <span className="truncate text-xs text-muted-foreground">{modelName}</span>}
            </>
          ) : (
          <span className="shrink-0 text-muted-foreground">
              {isBackgroundDispatch(item) ? (
                // No "N tools · Xs" claim here — this dispatch settles almost
                // immediately and never gains nested children, so that line
                // would always read "0 tools · 0s" and look stuck rather than
                // "running somewhere this card can't see."
                'Running in background'
              ) : (
                <>
                  {summary.toolCount} {summary.toolCount === 1 ? 'tool' : 'tools'}
                  {' · '}{formatElapsed(summary.elapsedMs)}
                </>
              )}
              {/* Only present when the spawn call named a model explicitly —
                  most subagents inherit the session's, and this is not the
                  place to guess one. Printed as the SDK gave it: this is not a
                  session's model, so there is no catalog row to resolve a
                  display name from. */}
              {modelName && <>{' · '}{modelName}</>}
            </span>
          )}
          {/*
            The visible state is carried by the chevron and, when blocked, by
            the chip below. Everything else gets a text equivalent here, for
            the same reason tool-card.tsx does: an icon-only state has no
            accessible name at all.
          */}
          <span className="sr-only">{subagentStateLabel(item, summary.blocked)}</span>
          {summary.blocked && !wstate && (
            // The `attention` tone from status-badge.tsx, spelled the same
            // way: text plus a quiet fill, never colour alone. A subagent
            // blocked on the user says the same thing the session badge
            // says, so it must not look like a different kind of event.
            <span className="ml-auto shrink-0 rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-medium">
              Needs you
            </span>
          )}
        </TraceCollapsibleTrigger>
          {hostedId && wstate && (
            <WorkerActions
              hostedId={hostedId}
              state={wstate}
              messaging={messaging}
              onToggleMessage={() => { setMessaging((v) => !v); setOpen(true); }}
              onOpenTranscript={() => openTranscript(item.id)}
            />
          )}
          {hostedId && (
            // The arrow stays at the far right like every other row's; the actions sit before it.
            <Button variant="ghost" size="icon-xs" className="ml-0.5 text-muted-foreground/60 hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent" aria-label={expanded ? 'Collapse' : 'Expand'} aria-expanded={expanded} onClick={() => changeOpen(!expanded)}>
              <ChevronRightIcon aria-hidden className={cn('transition-transform duration-200', expanded && 'rotate-90')} />
            </Button>
          )}
        </div>

        <TraceCollapsibleContent className={cn('mt-0.5 mb-2 border-t-0 py-0', embedded ? 'ml-5' : 'ml-2 border-l border-border pl-3')}>
          <div>
            {hostedId && wstate && <WorkerNotes item={item} state={wstate} />}
            {/*
              "Open full transcript" used to appear only once the inline
              window truncated something — but it doesn't just show more
              rows anymore, it opens the Fleet tab's read-only view (live
              permission-answering included), which is worth reaching for
              any subagent, not only a long-running one. Always offered
              while expanded; the "showing last N of M" text alone is
              conditional on truncation actually being in effect. A hosted
              worker has both links in its own action menu instead.
            */}
            {!hostedId && (
              <div className="flex items-center justify-between pb-1 text-muted-foreground">
                {children.length > shown.length && (
                  <p>showing last {shown.length} of {children.length}</p>
                )}
                <div className={cn('flex items-center gap-1', children.length <= shown.length && 'ml-auto')}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs font-normal"
                    onClick={() => openTranscript(item.id)}
                  >
                    Open full transcript
                  </Button>
                </div>
              </div>
            )}
            {hostedId && children.length > shown.length && (
              <p className="pb-1 text-muted-foreground">showing last {shown.length} of {children.length}</p>
            )}
            <div className="flex flex-col gap-1">
              {timeline.map((entry) => {
                if ('message' in entry) { return <WorkerMessageRow key={entry.message.id} message={entry.message} />; }
                const child = entry.child;
                return child.role === 'permission' ? (
                  // A pending approval is answered in the pinned strip above the composer, not here.
                  child.state === 'pending' ? null : <PermissionCard key={child.id} item={child} sessionId={sessionId} />
                ) : child.role === 'question' ? (
                  child.state === 'pending' ? null : <QuestionCard key={child.id} item={child} sessionId={sessionId} />
                ) : child.role === 'tool' ? (
                  <ToolCard key={child.id} item={child} />
                ) : null;
              })}
            </div>
            {hostedId && messaging && (
              <WorkerMessageBox
                hostedId={hostedId}
                name={subagentLabel(item)}
                running={item.state === 'running'}
                sent={sent}
                onSent={(body) => setSent((prev) => [...prev, body])}
              />
            )}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
  );
  return embedded ? card : <TranscriptItemShell role="subagent" label={hosted ? 'Worker' : 'Subagent'} ts={item.ts}>{card}</TranscriptItemShell>;
}
