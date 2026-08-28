import {
  MessageScroller, MessageScrollerContent, MessageScrollerItem, MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Button } from '@/components/ui/button';
import { ChevronLeftIcon } from 'lucide-react';
import { TranscriptItemView } from './transcript-item';
import { subagentLabel } from './subagent-window';
import type { SessionId, TranscriptItem } from '../../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

/**
 * A subagent's complete tool-call history, unwindowed — the drill-in
 * `PaneGroup` swaps a pane's `SessionHeader`+`Transcript` for when a
 * `SubagentCard` asks to open its full transcript. No `hasMore`/pagination:
 * a subagent's children are a fixed list already fully present in
 * `item.children`, never paged from the host.
 *
 * Renders inside the same `MessageScrollerProvider` `PaneGroup` already
 * mounts around the whole pane (see pane-group.tsx) — only one of
 * `SubagentTranscript` or the normal header+`Transcript` is ever mounted at
 * a time, so there is never more than one `MessageScroller.Root` registered
 * with that provider at once, and this component needs no provider of its
 * own.
 */
export function SubagentTranscript({
  item, sessionId, onBack, title,
}: {
  item: ToolItem;
  sessionId: SessionId;
  onBack: () => void;
  /** The pane's session title, for the breadcrumb's accessible label. */
  title: string;
}) {
  const children = item.children ?? [];
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
        <Button variant="ghost" size="icon-xs" aria-label={`Back to ${title}`} onClick={onBack}>
          <ChevronLeftIcon aria-hidden />
        </Button>
        <span className="truncate font-medium">Subagent: {subagentLabel(item)}</span>
      </div>
      <div className="min-h-0 flex-1">
        <MessageScroller className="h-full">
          <MessageScrollerViewport className="px-2">
            <MessageScrollerContent className="justify-end gap-2">
              {children.map((child) => (
                <MessageScrollerItem key={child.id} messageId={child.id}>
                  <TranscriptItemView item={child} sessionId={sessionId} />
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </div>
    </div>
  );
}
