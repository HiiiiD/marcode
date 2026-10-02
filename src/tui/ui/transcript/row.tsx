import type { ReactNode } from 'react';
import type { TranscriptRow } from '../../view/transcript-rows';
import { ChatMessage } from '../termcn/components/ui/chat-message';
import { useTheme } from '../termcn/hooks/use-theme';
import { useSyntaxStyle, useTokens } from '../tokens/tokens-provider';
import { BAR_CHARS } from './bar-border';
import { PermissionCard } from './permission-card';
import { RelocationCardView, type RelocationKeys } from './relocation-card';
import { SubagentCard } from './subagent-card';
import { ToolCard } from './tool-card';

// Readable measure on wide terminals; the bar groups a message with its body.
const MAX_WIDTH = 100;

function Bar({ color, tint, children }: { color: string; tint?: boolean; children: ReactNode }) {
  const tokens = useTokens();
  return (
    <box
      maxWidth={MAX_WIDTH}
      marginBottom={1}
      border={['left']}
      borderStyle="single"
      {...(tokens ? { customBorderChars: BAR_CHARS } : {})}
      borderColor={color}
      backgroundColor={tokens && tint ? tokens.panel : undefined}
      paddingLeft={1}
    >
      {children}
    </box>
  );
}

export function RowView(props: { row: TranscriptRow; selected: boolean; expanded: boolean; closed: boolean; relocationKeys: RelocationKeys }) {
  const { row } = props;
  const theme = useTheme();
  const syntaxStyle = useSyntaxStyle();
  const tokens = useTokens();
  const bold = props.selected ? 1 : 0;
  switch (row.kind) {
    case 'user':
      return (
        <Bar color={theme.colors.primary} tint>
          <ChatMessage sender="user" name={row.fromName}>
            <text attributes={bold} wrapMode="word">{row.text}</text>
          </ChatMessage>
        </Bar>
      );
    case 'assistant':
      return (
        <Bar color={tokens ? tokens.menu : theme.colors.success}>
          <ChatMessage sender="assistant">
            <markdown content={row.text} streaming={row.streaming} syntaxStyle={syntaxStyle} />
          </ChatMessage>
        </Bar>
      );
    case 'tool':
      return row.item.tool.kind === 'subagent'
        ? <SubagentCard item={row.item} open={props.expanded} userClosed={props.closed} selected={props.selected} />
        : <ToolCard item={row.item} permission={row.permission} open={props.expanded} selected={props.selected} />;
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
    case 'notice':
      return <text attributes={bold} fg={row.tone === 'error' ? theme.colors.error : theme.colors.mutedForeground} wrapMode="word">{row.text}</text>;
  }
}
