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
    <MessageScrollerProvider
      autoScroll
      defaultScrollPosition="last-anchor"
      scrollPreviousItemPeek={64}
    >
      <MessageScroller className="h-full">
        <MessageScrollerViewport className="px-2" preserveScrollOnPrepend>
          <MessageScrollerContent>
            {pane.hasMore && first && (
              <Button
                variant="outline"
                disabled={loadingBeforeId === first.id}
                onClick={() => {
                  setLoadingBeforeId(first.id);
                  onLoadMore(first.id);
                }}
                className="my-2 h-auto w-full py-1 text-xs"
              >
                Load earlier messages
              </Button>
            )}
            {pane.items.map((item) => (
              <MessageScrollerItem
                key={item.id}
                messageId={item.id}
                scrollAnchor={item.role === 'user'}
              >
                <TranscriptItemView item={item} />
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
