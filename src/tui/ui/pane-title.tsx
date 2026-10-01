import { statusGlyph } from '../view/roster-rows';
import type { SessionSummary } from '../../protocol/messages';
import { useTheme } from './termcn/hooks/use-theme';

export function paneTitleText(s: SessionSummary | undefined, id: string, needsYou: boolean): string {
  if (!s) { return id; }
  const owner = s.owner ? ` ${s.owner.host}·${s.owner.pid}` : '';
  return `${statusGlyph(s.status)} ${s.name || s.title}${owner}${needsYou ? ' !' : ''}`;
}

export function PaneTitle(props: { text: string; focused: boolean; onHide(): void }) {
  const theme = useTheme();
  return (
    <box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0}>
      <text fg={props.focused ? theme.colors.primary : theme.colors.mutedForeground} attributes={props.focused ? 1 : 0} truncate>
        {props.text}
      </text>
      <text fg={theme.colors.mutedForeground} onMouseDown={(e) => { e.stopPropagation(); props.onHide(); }}>{' ✕'}</text>
    </box>
  );
}
