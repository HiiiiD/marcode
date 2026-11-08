import { modeCanEdit } from '../../shared/side-chat-mode';
import type { SessionSummary } from '../../protocol/messages';
import { useTheme } from './termcn/hooks/use-theme';

/** One line under a side chat's title: what it is, whether it can edit, and the chords that leave it. */
export function SideChatBar({ summary }: { summary: SessionSummary }) {
  const theme = useTheme();
  if (summary.kind !== 'side') { return null; }
  return (
    <box flexShrink={0} flexDirection="row">
      <text fg={theme.colors.mutedForeground} truncate>
        Side chat
        {modeCanEdit(summary.permissionMode) ? <span fg={theme.colors.destructive}> · Can edit files</span> : null}
        {' · ^W b bring back · ^W p promote · ^W x close'}
      </text>
    </box>
  );
}
