import { useEffect, useMemo, useState } from 'react';
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent,
  MessageScrollerItem, MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Button } from '@/components/ui/button';
import { NestedMessagesContext } from './nested-messages-context';
import { SubagentGroupCard } from './subagent-group-card';
import { TranscriptItemView } from './transcript-item';
import type { PaneState } from '../reducer';
import { isLivePrompt } from '../lib/pending-prompts';
import { splitNestedMessages } from '../lib/nested-messages';
import { groupSubagents, mergeToolRuns } from '../lib/subagent-groups';
import { settledPrefix } from '../lib/stream-text';
import { beatOf, gapAbove } from '../lib/rhythm';

export function Transcript({
  pane, onLoadMore,
}: {
  pane: PaneState;
  onLoadMore: (beforeItemId: string) => void;
}) {
  const nested = useMemo(() => splitNestedMessages(pane.items), [pane.items]);
  const first = pane.items[0];
  const idle = pane.summary.status === 'idle';
  // Claude hands over finished blocks; every other backend streams tokens, so its half-written tail is held back to the last whole line or sentence rather than re-rendered per token.
  const last = pane.items[pane.items.length - 1];
  const streamingId = pane.summary.status === 'running' && !pane.summary.providerId.startsWith('claude') && last?.role === 'assistant' && last.text.trim() ? last.id : undefined;

  // `load-more` is a stateless lookup keyed on beforeItemId, not a consumed
  // cursor — two rapid clicks before the first session-prepend lands would
  // post the same beforeItemId twice and duplicate the prepended items. Track
  // whether a request for the current oldest item is in flight and disable
  // the button meanwhile. Reset when the oldest item changes (the request
  // landed, or history was reset) or when there's nothing left to load.
  const [loadingBeforeId, setLoadingBeforeId] = useState<string | null>(null);

  useEffect(() => {
    setLoadingBeforeId(null);
  }, [first?.id, pane.hasMore]);

  return (
    // No `MessageScrollerProvider` here: it lives in `pane-group.tsx`, one
    // level up, so that `SessionHeader` — a sibling of this component, not a
    // descendant — can call `useMessageScroller()` to reveal an item in this
    // transcript. Nothing else about the scroller moved.
    <NestedMessagesContext value={nested.byChild}>
      <MessageScroller className="h-full">
        <MessageScrollerViewport className="px-2" preserveScrollOnPrepend>
          {/* `justify-end` only bites while the content is shorter than the
              viewport (Content is `min-h-full`): a two-message session sits on
              the composer instead of stranding itself at the top with dead
              space below. Once it overflows, the rule is inert. */}
          <MessageScrollerContent className="justify-end gap-0">
            {pane.hasMore && first && (
              <Button
                variant="outline"
                size="sm"
                disabled={loadingBeforeId === first.id}
                onClick={() => {
                  setLoadingBeforeId(first.id);
                  onLoadMore(first.id);
                }}
                // The fixed h-7 comes from `size="sm"`, not a hand-written
                // height — see the note on tool-card.tsx's own Button.
                className="my-0 w-full text-xs"
              >
                Load earlier messages
              </Button>
            )}
            {(() => {
              const entries = mergeToolRuns(groupSubagents(nested.main
                .map((item) => (item.id === streamingId && item.role === 'assistant' ? { ...item, text: settledPrefix(item.text) } : item))
                .filter((item) => !isLivePrompt(item, pane) && !(item.role === 'assistant' && item.id === streamingId && !item.text && !item.thinking))));
              const beatAt = (i: number) => {
                const e = entries[i];
                return e === undefined ? undefined : e.kind === 'group' ? 'machine' as const : beatOf(e.item);
              };
              return entries.map((entry, i) => {
                const gap = gapAbove(beatAt(i - 1), beatAt(i) ?? 'card');
                return entry.kind === 'group' ? (
                  <MessageScrollerItem key={entry.id} messageId={entry.id} className={gap}>
                    <SubagentGroupCard items={entry.items} sessionId={pane.summary.id} />
                  </MessageScrollerItem>
                ) : (
                  <MessageScrollerItem key={entry.item.id} messageId={entry.item.id} className={gap}>
                    <TranscriptItemView item={entry.item} more={entry.more} sessionId={pane.summary.id} canFork={idle && pane.summary.kind !== 'side'} />
                  </MessageScrollerItem>
                );
              });
            })()}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton className="right-4 left-auto translate-x-0 rtl:translate-x-0" />
      </MessageScroller>
    </NestedMessagesContext>
  );
}
