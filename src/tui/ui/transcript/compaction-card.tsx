import { TextAttributes } from '@opentui/core';
import type { TranscriptRow } from '../../view/transcript-rows';
import { useTheme } from '../termcn/hooks/use-theme';
import { useSyntaxStyle } from '../tokens/tokens-provider';
import { SPINNER, useTick } from '../use-ticker';
import { Collapsible } from './collapsible';

type CompactionRow = Extract<TranscriptRow, { kind: 'compaction' }>;

export function CompactionCard(props: { row: CompactionRow; open: boolean; selected: boolean }) {
  const theme = useTheme();
  const syntaxStyle = useSyntaxStyle();
  const { row } = props;
  const running = row.state === 'running';
  const failed = row.state === 'failed';
  const tick = useTick(running);
  const muted = theme.colors.mutedForeground;
  const glyph = running ? SPINNER[tick % SPINNER.length] : failed ? '✗' : '⇲';
  const title = row.error ? `${row.headline}: ${row.error}` : row.headline;
  return (
    <Collapsible
      open={props.open && row.summary !== undefined}
      selected={props.selected}
      header={(
        <>
          <text fg={failed ? theme.colors.error : muted} flexShrink={0}>{glyph}</text>
          <box flexGrow={1} flexShrink={1} minWidth={0} height={1} overflow="hidden">
            <text fg={failed ? theme.colors.error : muted} attributes={props.selected ? TextAttributes.BOLD : TextAttributes.NONE} wrapMode="none">{title}</text>
          </box>
          {row.summary ? <text fg={muted} flexShrink={0}>{props.open ? 'hide summary' : 'show summary'}</text> : null}
        </>
      )}
    >
      {row.summary ? <markdown content={row.summary} syntaxStyle={syntaxStyle} /> : null}
    </Collapsible>
  );
}
