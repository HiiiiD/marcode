import { SyntaxStyle } from '@opentui/core';
import type { TranscriptRow } from '../../view/transcript-rows';
import { ChatMessage } from '../termcn/components/ui/chat-message';
import { useTheme } from '../termcn/hooks/use-theme';
import { ToolCall } from '../termcn/components/ui/tool-call';

const syntaxStyle = SyntaxStyle.create();

export function RowView(props: { row: TranscriptRow; selected: boolean; expanded: boolean }) {
  const { row } = props;
  const theme = useTheme();
  const bold = props.selected ? 1 : 0;
  switch (row.kind) {
    case 'user':
      return (
        <ChatMessage sender="user" name={row.fromName}>
          <text attributes={bold} wrapMode="word">{row.text}</text>
        </ChatMessage>
      );
    case 'assistant':
      return (
        <ChatMessage sender="assistant">
          <markdown content={row.text} streaming={row.streaming} syntaxStyle={syntaxStyle} />
        </ChatMessage>
      );
    case 'tool':
      return (
        <box flexDirection="row" gap={1} paddingLeft={row.depth * 2}>
          <text attributes={bold} fg={props.selected ? theme.colors.primary : theme.colors.mutedForeground}>
            {props.expanded ? '▾' : '▸'}
          </text>
          <ToolCall
            name={`${row.header.verb} ${row.header.primary}`}
            status={row.state === 'ok' ? 'success' : row.state}
            collapsible={false}
          />
        </box>
      );
    case 'permission':
      return <text attributes={bold} fg="yellow" wrapMode="word">{`? ${row.header.verb} ${row.header.primary} — ${row.state}${row.reason ? ` (${row.reason})` : ''}`}</text>;
    case 'question':
      return <text attributes={bold} fg="yellow" wrapMode="word">{`? ${row.text} — ${row.state}`}</text>;
    case 'notice':
      return <text attributes={bold} fg={row.tone === 'error' ? 'red' : 'gray'} wrapMode="word">{row.text}</text>;
  }
}
