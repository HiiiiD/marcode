import { ToolCard } from './tool-card';
import type { TranscriptItem } from '../../protocol/messages';

export function TranscriptItemView({ item }: { item: TranscriptItem }) {
  switch (item.role) {
    case 'user':
      return (
        <div className="my-2 rounded bg-muted px-2 py-1 whitespace-pre-wrap">
          {item.text}
        </div>
      );

    case 'assistant':
      return (
        <div className="my-2 whitespace-pre-wrap">
          {item.thinking && (
            <div className="mb-1 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
              {item.thinking}
            </div>
          )}
          {item.text}
        </div>
      );

    case 'tool':
      return <ToolCard item={item} />;

    case 'error':
      return (
        <div className="my-2 rounded border border-destructive px-2 py-1 text-xs text-destructive">
          {item.message}
        </div>
      );

    case 'permission':
      return null;
  }
}
