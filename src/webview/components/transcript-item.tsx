import { PermissionCard } from './permission-card';
import { ToolCard } from './tool-card';
import type { SessionId, TranscriptItem } from '../../protocol/messages';

export function TranscriptItemView({
  item, sessionId,
}: {
  item: TranscriptItem;
  sessionId: SessionId;
}) {
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
      return <PermissionCard item={item} sessionId={sessionId} />;

    default:
      // The TranscriptItem type is closed, but nothing guarantees a runtime
      // value matches it (schema drift between an older webview bundle and a
      // newer host, or corrupted persisted transcript data). Render an
      // unobtrusive placeholder rather than falling off the switch and
      // returning undefined, which React treats as a render error and would
      // unmount the whole transcript.
      return (
        <div className="my-2 text-xs text-muted-foreground">Unsupported item</div>
      );
  }
}
