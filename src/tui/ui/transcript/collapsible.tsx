import type { ReactNode } from 'react';
import { useTheme } from '../termcn/hooks/use-theme';

const MAX_WIDTH = 100;

export function Collapsible(props: { open: boolean; selected: boolean; header: ReactNode; children?: ReactNode }) {
  const theme = useTheme();
  const border = theme.colors.border;
  return (
    <box
      flexDirection="column"
      maxWidth={MAX_WIDTH}
      border
      borderStyle="single"
      borderColor={props.selected ? theme.colors.primary : border}
    >
      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>{props.header}</box>
      {props.open ? (
        <box flexDirection="column" border={['top']} borderStyle="single" borderColor={border} paddingLeft={1} paddingRight={1}>
          {props.children}
        </box>
      ) : null}
    </box>
  );
}
