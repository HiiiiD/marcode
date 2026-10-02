import type { ReactNode } from 'react';
import { useTheme } from '../termcn/hooks/use-theme';
import type { TuiTokens } from '../tokens/derive-tokens';
import { BAR_CHARS } from './bar-border';

export function Panel(props: {
  tokens: TuiTokens; open: boolean; selected: boolean; maxWidth: number; header: ReactNode; children?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <box
      flexDirection="column"
      maxWidth={props.maxWidth}
      marginBottom={1}
      border={['left']}
      customBorderChars={BAR_CHARS}
      borderColor={props.selected ? theme.colors.primary : theme.colors.border}
      backgroundColor={props.tokens.panel}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* Only the header strip lights up: a diff in the body paints its own panel-colored rows and must not mismatch. */}
      <box flexDirection="row" gap={1} backgroundColor={props.selected ? props.tokens.menu : undefined}>{props.header}</box>
      {props.open ? <box flexDirection="column" paddingTop={1}>{props.children}</box> : null}
    </box>
  );
}
