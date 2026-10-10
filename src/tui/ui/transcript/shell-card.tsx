import { TextAttributes } from '@opentui/core';
import type { TranscriptRow } from '../../view/transcript-rows';
import { useTheme } from '../termcn/hooks/use-theme';
import { SPINNER, useTick } from '../use-ticker';
import { Collapsible } from './collapsible';

type ShellRow = Extract<TranscriptRow, { kind: 'shell' }>;
const CLAMP_LINES = 12;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function ShellCard({ row, expanded, selected }: { row: ShellRow; expanded: boolean; selected: boolean }) {
  const theme = useTheme();
  const { card } = row;
  const tick = useTick(card.running);
  const muted = theme.colors.mutedForeground;
  const accent = card.failed ? theme.colors.error : muted;
  const text = card.output.replace(ANSI, '').replace(/\r/g, '').trimEnd();
  const lines = text === '' ? [] : text.split('\n');
  const hidden = expanded ? 0 : Math.max(0, lines.length - CLAMP_LINES);
  const shown = hidden > 0 ? lines.slice(-CLAMP_LINES) : lines;
  const hint = hidden > 0
    ? `${hidden} earlier lines hidden, Enter shows all`
    : expanded && lines.length > CLAMP_LINES ? 'Enter collapses' : undefined;
  return (
    <Collapsible
      open={lines.length > 0}
      selected={selected}
      header={(
        <>
          <text fg={accent} flexShrink={0}>{card.running ? SPINNER[tick % SPINNER.length] : '$'}</text>
          <box flexGrow={1} flexShrink={1} minWidth={0} height={1} overflow="hidden">
            <text attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE} wrapMode="none">{card.command}</text>
          </box>
          <text fg={accent} flexShrink={0}>{card.footer}</text>
        </>
      )}
    >
      {hint ? <text fg={muted}>{hint}</text> : null}
      <text fg={muted} wrapMode="word">{shown.join('\n')}</text>
    </Collapsible>
  );
}
