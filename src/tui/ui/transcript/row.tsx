import { SyntaxStyle } from '@opentui/core';
import type { TranscriptRow } from '../../view/transcript-rows';

const MARK = { running: '…', ok: '', error: ' ✗' } as const;
const syntaxStyle = SyntaxStyle.create();

export function RowView(props: { row: TranscriptRow; selected: boolean; expanded: boolean }) {
  const { row } = props;
  const bold = props.selected ? 1 : 0;
  switch (row.kind) {
    case 'user':
      return <text attributes={bold} wrapMode="word">{`> ${row.fromName ? `[${row.fromName}] ` : ''}${row.text}`}</text>;
    case 'assistant':
      return <markdown content={row.text} streaming={row.streaming} syntaxStyle={syntaxStyle} />;
    case 'tool':
      return (
        <text attributes={bold} fg="gray" wrapMode="word">
          {`${' '.repeat(row.depth * 2)}${props.expanded ? '▾' : '▸'} ${row.header.verb} ${row.header.primary}${MARK[row.state]}`}
        </text>
      );
    case 'permission':
      return <text attributes={bold} fg="yellow" wrapMode="word">{`? ${row.header.verb} ${row.header.primary} — ${row.state}${row.reason ? ` (${row.reason})` : ''}`}</text>;
    case 'question':
      return <text attributes={bold} fg="yellow" wrapMode="word">{`? ${row.text} — ${row.state}`}</text>;
    case 'notice':
      return <text attributes={bold} fg={row.tone === 'error' ? 'red' : 'gray'} wrapMode="word">{row.text}</text>;
  }
}
