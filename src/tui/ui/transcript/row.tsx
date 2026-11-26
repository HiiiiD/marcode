import type { Attachment } from '../../../protocol/messages';
import type { TranscriptRow } from '../../view/transcript-rows';
import { useTheme } from '../termcn/hooks/use-theme';
import { useSyntaxStyle, useTokens } from '../tokens/tokens-provider';
import { SentAttachments } from '../attachment-chips';
import { CompactionCard } from './compaction-card';
import { PermissionCard } from './permission-card';
import { RelocationCardView, type RelocationKeys } from './relocation-card';
import { SubagentCard } from './subagent-card';
import { ToolCard } from './tool-card';

// Readable measure on wide terminals.
const MAX_WIDTH = 100;

export function RowView(props: {
  row: TranscriptRow; selected: boolean; expanded: boolean; closed: boolean; relocationKeys: RelocationKeys;
  attachmentCursor?: number; onOpenAttachment(a: Attachment): void;
}) {
  const { row } = props;
  const theme = useTheme();
  const syntaxStyle = useSyntaxStyle();
  const tokens = useTokens();
  const bold = props.selected ? 1 : 0;
  switch (row.kind) {
    case 'user':
      // The user's own turn sits on the right of the measure, sized to its text; the fill (or, without a palette, the
      // primary colour) says whose it is, so only a sender from another session is named.
      return (
        <box maxWidth={MAX_WIDTH} flexDirection="column" alignItems="flex-end">
          <box flexDirection="column" backgroundColor={tokens?.panel} paddingLeft={1} paddingRight={1}>
            {row.fromName ? <text fg={theme.colors.mutedForeground}>{`Message from ${row.fromName}`}</text> : null}
            <text fg={tokens ? undefined : theme.colors.primary} attributes={bold} wrapMode="word">{row.text}</text>
            {row.attachments ? <SentAttachments attachments={row.attachments} cursor={props.attachmentCursor} onOpen={props.onOpenAttachment} /> : null}
          </box>
        </box>
      );
    case 'assistant':
      return (
        <box maxWidth={MAX_WIDTH}>
          <markdown content={row.text} streaming={row.streaming} syntaxStyle={syntaxStyle} />
        </box>
      );
    case 'tool':
      return row.item.tool.kind === 'subagent' && row.item.tool.action !== 'message'
        ? <SubagentCard item={row.item} open={props.expanded} userClosed={props.closed} selected={props.selected} />
        : <ToolCard item={row.item} permission={row.permission} open={row.userShell ? !props.expanded : props.expanded} streaming={row.userShell === true} selected={props.selected} />;
    case 'permission':
      return <PermissionCard header={row.header} state={row.state} reason={row.reason} selected={props.selected} />;
    case 'question':
      return (
        <text attributes={bold} wrapMode="word">
          <span fg={theme.colors.warning}>{'? '}</span>
          {`${row.text} — ${row.state}`}
        </text>
      );
    case 'relocation':
      return <RelocationCardView card={row.card} active={row.active} keys={props.relocationKeys} selected={props.selected} />;
    case 'compaction':
      return <CompactionCard row={row} open={props.expanded} selected={props.selected} />;
    case 'notice':
      return <text attributes={bold} fg={row.tone === 'error' ? theme.colors.error : theme.colors.mutedForeground} wrapMode="word">{row.text}</text>;
  }
}
