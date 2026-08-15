import { EditorContextChip } from './editor-context-chip';
import { Markdown } from './markdown';
import { PermissionCard } from './permission-card';
import { ReasoningBlock } from './reasoning-block';
import { SubagentCard } from './subagent-card';
import { ToolCard } from './tool-card';
import { TranscriptItemShell } from './transcript-item-shell';
import { useStore } from '../store';
import type { SessionId, TranscriptItem } from '../../protocol/messages';

export function TranscriptItemView({
  item, sessionId,
}: {
  item: TranscriptItem;
  sessionId: SessionId;
}) {
  switch (item.role) {
    case 'user':
      return <UserItem item={item} />;

    case 'assistant':
      return (
        <TranscriptItemShell role="assistant" label="Agent" ts={item.ts}>
          {item.thinking && <ReasoningBlock text={item.thinking} />}
          <Markdown>{item.text}</Markdown>
        </TranscriptItemShell>
      );

    case 'tool':
      // A tool item only grows `children` once its subagent actually does
      // something, so a Task that ran nothing renders as an ordinary tool
      // card — correct, since there is nothing nested to show.
      return item.children && item.children.length > 0
        ? <SubagentCard item={item} sessionId={sessionId} />
        : <ToolCard item={item} />;

    case 'error':
      return (
        <TranscriptItemShell role="error" label="Error" ts={item.ts}>
          <div className="max-h-48 overflow-auto rounded border border-destructive px-2 py-1 text-xs wrap-break-word whitespace-pre-wrap text-destructive">
            {item.message}
          </div>
        </TranscriptItemShell>
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
        <div className="my-0 text-xs text-muted-foreground">Unsupported item</div>
      );
  }
}

function UserItem({ item }: { item: Extract<TranscriptItem, { role: 'user' }> }) {
  const { post } = useStore();
  const ctx = item.context;

  return (
    <TranscriptItemShell role="user" label="You" ts={item.ts}>
      {ctx && (
        <div className="mb-1 flex">
          <EditorContextChip
            ctx={ctx}
            onClick={() => post({
              t: 'reveal-file',
              path: ctx.path,
              startLine: ctx.selection?.ranges[0]?.startLine,
            })}
          />
        </div>
      )}
      {/* No inner box: the shell's own filled block is what marks this as the
          user's turn. A second surface inside it was a nested card that read
          as a shade of nothing. */}
      <div className="wrap-break-word whitespace-pre-wrap">
        {item.text}
      </div>
    </TranscriptItemShell>
  );
}
