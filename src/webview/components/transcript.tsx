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
                onClick={() => onLoadMore(first.id)}
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
