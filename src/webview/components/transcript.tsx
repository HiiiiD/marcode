import { useEffect, useState } from 'react';
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent,
  MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Button } from '@/components/ui/button';
import { TranscriptItemView } from './transcript-item';
import type { PaneState } from '../reducer';

export function Transcript({
  pane, onLoadMore,
}: {
  pane: PaneState;
  onLoadMore: (beforeItemId: string) => void;
}) {
  const first = pane.items[0];

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
    // Chat-shaped, not document-shaped: the latest item is pinned to the
    // bottom edge and history grows upward off the top. `end` rather than
    // `last-anchor` — anchoring parks the newest user message at the *top* of
    // the viewport and streams the reply beneath it, which reads as a document
    // scrolling past, not a conversation.
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="h-full">
        <MessageScrollerViewport className="px-2" preserveScrollOnPrepend>
          {/* `justify-end` only bites while the content is shorter than the
              viewport (Content is `min-h-full`): a two-message session sits on
              the composer instead of stranding itself at the top with dead
              space below. Once it overflows, the rule is inert. */}
          <MessageScrollerContent className="justify-end gap-2">
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
            {pane.items.map((item) => (
              <MessageScrollerItem key={item.id} messageId={item.id}>
                <TranscriptItemView item={item} sessionId={pane.summary.id} />
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
