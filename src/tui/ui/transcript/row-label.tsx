import { TextAttributes } from '@opentui/core';
import { useTheme } from '../termcn/hooks/use-theme';

// One label column for every row type, so targets start on the same column down the log.
export const LABEL_WIDTH = 8;

export function RowLabel({ text, selected }: { text: string; selected: boolean }) {
  const theme = useTheme();
  return (
    <box minWidth={LABEL_WIDTH} flexShrink={0} height={1} overflow="hidden">
      <text fg={selected ? undefined : theme.colors.mutedForeground} attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE} wrapMode="none">{text}</text>
    </box>
  );
}
