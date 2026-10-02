import type { ReactNode } from 'react';
import { useTheme } from '../termcn/hooks/use-theme';
import { useTokens } from '../tokens/tokens-provider';
import { Panel } from './panel';

const MAX_WIDTH = 100;
// A native diff needs room to go side by side; prose and command output stay at the readable measure.
const WIDE_MAX_WIDTH = 180;

export function Collapsible(props: { open: boolean; selected: boolean; wide?: boolean; header: ReactNode; children?: ReactNode }) {
  const theme = useTheme();
  const tokens = useTokens();
  const maxWidth = props.wide ? WIDE_MAX_WIDTH : MAX_WIDTH;
  if (tokens) {
    return <Panel tokens={tokens} open={props.open} selected={props.selected} maxWidth={maxWidth} header={props.header}>{props.children}</Panel>;
  }
  const border = theme.colors.border;
  return (
    <box
      flexDirection="column"
      maxWidth={maxWidth}
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
