import type { ToolHeader } from '../../../client-core/tool-render';
import { useTheme } from '../termcn/hooks/use-theme';
import { Collapsible } from './collapsible';
import { RowLabel } from './row-label';

type PermissionState = 'pending' | 'allowed' | 'denied';

export function PermissionCard(props: { header: ToolHeader; state: PermissionState; reason?: string; selected: boolean }) {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  const mark = props.state === 'allowed'
    ? { text: '✓', fg: theme.colors.success }
    : props.state === 'denied' ? { text: '✗', fg: theme.colors.error } : { text: '?', fg: theme.colors.warning };
  return (
    <Collapsible
      open={props.reason !== undefined}
      header={(
        <>
          <text fg={mark.fg} flexShrink={0}>{mark.text}</text>
          <RowLabel text={props.header.verb} selected={props.selected} />
          <box flexGrow={1} flexShrink={100} minWidth={0} height={1} overflow="hidden">
            <text wrapMode="none">{props.header.primary}</text>
          </box>
          <text fg={muted} flexShrink={0}>{props.state}</text>
        </>
      )}
    >
      <text fg={muted} wrapMode="word">{props.reason}</text>
    </Collapsible>
  );
}
