import { statusGlyph } from '../view/roster-rows';
import type { SessionSummary } from '../../protocol/messages';
import { useTheme } from './termcn/hooks/use-theme';
import { useTokens } from './tokens/tokens-provider';

export function paneTitleText(s: SessionSummary | undefined, id: string, needsYou: boolean): string {
  if (!s) { return id; }
  const owner = s.owner ? ` ${s.owner.host}·${s.owner.pid}` : '';
  return `${statusGlyph(s.status)} ${s.name || s.title}${owner}${needsYou ? ' !' : ''}`;
}

export function PaneTitle(props: { text: string; focused: boolean; onHide(): void }) {
  const theme = useTheme();
  const tokens = useTokens();
  const muted = tokens?.textMuted ?? theme.colors.mutedForeground;
  const lit = tokens ? tokens.text : theme.colors.primary;
  return (
    <box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0}>
      <text fg={props.focused ? lit : muted} attributes={props.focused ? 1 : 0} truncate>
        {props.text}
      </text>
      <text fg={muted} onMouseDown={(e) => { e.stopPropagation(); props.onHide(); }}>{' ✕'}</text>
    </box>
  );
}
