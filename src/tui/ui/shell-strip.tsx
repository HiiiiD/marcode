import type { SessionId } from '../../protocol/messages';
import { runningShell } from '../../client-core/running-shell';
import { useTheme } from './termcn/hooks/use-theme';
import { useTuiStore } from './store';
import { SPINNER, useTick } from './use-ticker';

/** A running command's cancel handle, kept in view above the composer however far its card has scrolled. */
export function ShellStrip({ sessionId }: { sessionId: SessionId }) {
  const { state, post } = useTuiStore();
  const theme = useTheme();
  const pane = state.byId[sessionId];
  const item = pane && !pane.summary.owner ? runningShell(pane.items) : undefined;
  const tick = useTick(item !== undefined);
  if (!item) { return null; }
  const cancel = () => { post({ t: 'cancel-shell', id: sessionId, itemId: item.id }); };
  return (
    <box flexDirection="row" gap={1} height={1} onMouseDown={cancel}>
      <text fg={theme.colors.mutedForeground} flexShrink={0}>{SPINNER[tick % SPINNER.length]}</text>
      <box flexGrow={1} flexShrink={1} minWidth={0} height={1} overflow="hidden">
        <text wrapMode="none">{`$ ${item.command}`}</text>
      </box>
      <text fg={theme.colors.mutedForeground} flexShrink={0}>Esc or click to cancel</text>
    </box>
  );
}
