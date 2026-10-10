import { TextAttributes } from '@opentui/core';
import type { TranscriptRow } from '../../view/transcript-rows';
import { useTheme } from '../termcn/hooks/use-theme';
import { SPINNER, useTick } from '../use-ticker';

type ShellRow = Extract<TranscriptRow, { kind: 'shell' }>;
const RUNNING_LINES = 12;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function ShellCard({ row, selected }: { row: ShellRow; selected: boolean }) {
  const theme = useTheme();
  const { card } = row;
  const tick = useTick(card.running);
  const lines = card.output.replace(ANSI, '').replace(/\r/g, '').trimEnd().split('\n');
  const shown = card.running && lines.length > RUNNING_LINES ? lines.slice(-RUNNING_LINES) : lines;
  const accent = card.failed ? theme.colors.error : theme.colors.mutedForeground;
  return (
    <box flexDirection="column">
      <text attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE} wrapMode="word">
        <span fg={accent}>{card.running ? `${SPINNER[tick % SPINNER.length]} ` : '$ '}</span>
        {card.command}
      </text>
      {card.output.trim() === '' ? null : <text fg={theme.colors.mutedForeground} wrapMode="word">{shown.join('\n')}</text>}
      <text fg={accent}>{card.footer}</text>
    </box>
  );
}
