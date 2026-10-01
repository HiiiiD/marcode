import { SyntaxStyle } from '@opentui/core';
import type { ReactNode } from 'react';
import type { TranscriptRow } from '../../view/transcript-rows';
import { ChatMessage } from '../termcn/components/ui/chat-message';
import { useTheme } from '../termcn/hooks/use-theme';
import { ToolCard } from './tool-card';

const syntaxStyle = SyntaxStyle.create();
// Readable measure on wide terminals; the bar groups a message with its body.
const MAX_WIDTH = 100;

function Bar({ color, children }: { color: string; children: ReactNode }) {
  return (
    <box maxWidth={MAX_WIDTH} marginBottom={1} border={['left']} borderStyle="single" borderColor={color} paddingLeft={1}>
      {children}
    </box>
  );
}

export function RowView(props: { row: TranscriptRow; selected: boolean; expanded: boolean }) {
  const { row } = props;
  const theme = useTheme();
  const bold = props.selected ? 1 : 0;
  switch (row.kind) {
    case 'user':
      return (
        <Bar color={theme.colors.primary}>
          <ChatMessage sender="user" name={row.fromName}>
            <text attributes={bold} wrapMode="word">{row.text}</text>
          </ChatMessage>
        </Bar>
      );
    case 'assistant':
      return (
        <Bar color={theme.colors.success}>
          <ChatMessage sender="assistant">
            <markdown content={row.text} streaming={row.streaming} syntaxStyle={syntaxStyle} />
          </ChatMessage>
        </Bar>
      );
    case 'tool':
      return <ToolCard item={row.item} open={props.expanded} selected={props.selected} />;
    case 'permission':
      return (
        <text attributes={bold} wrapMode="word">
          <span fg={theme.colors.warning}>{'? '}</span>
          {`${row.header.verb} ${row.header.primary} — ${row.state}${row.reason ? ` (${row.reason})` : ''}`}
        </text>
      );
    case 'question':
      return (
        <text attributes={bold} wrapMode="word">
          <span fg={theme.colors.warning}>{'? '}</span>
          {`${row.text} — ${row.state}`}
        </text>
      );
    case 'notice':
      return <text attributes={bold} fg={row.tone === 'error' ? 'red' : 'gray'} wrapMode="word">{row.text}</text>;
  }
}
