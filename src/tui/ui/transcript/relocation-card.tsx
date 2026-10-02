import { TextAttributes } from '@opentui/core';
import type { RelocationCard } from '../../view/relocation-view';
import { useTheme } from '../termcn/hooks/use-theme';
import { Collapsible } from './collapsible';

export type RelocationKeys = 'live' | 'idle' | 'none';

function hint(card: RelocationCard, active: boolean, keys: RelocationKeys): string | undefined {
  if (card.state === 'moved' || card.state === 'stayed') { return undefined; }
  if (!active) { return 'superseded by a newer offer'; }
  if (keys === 'none') { return undefined; }
  if (keys === 'idle') { return 'focus this pane to answer'; }
  return card.state === 'queued' ? '^L cancel' : '^Y move  ^L stay';
}

export function RelocationCardView(props: { card: RelocationCard; active: boolean; keys: RelocationKeys; selected: boolean }) {
  const theme = useTheme();
  const { card } = props;
  const muted = theme.colors.mutedForeground;
  const settled = card.state === 'moved' || card.state === 'stayed';
  const title = card.state === 'moved' ? `Moved to ${card.name}` : card.state === 'stayed' ? 'Stayed'
    : card.state === 'queued' ? `Interrupting the turn to move to ${card.name}` : 'New worktree';
  const keyHint = hint(card, props.active, props.keys);
  return (
    <Collapsible
      open={!settled}
      selected={props.selected}
      header={(
        <>
          <text fg={settled ? muted : theme.colors.warning} flexShrink={0}>⎇</text>
          <box flexGrow={1} flexShrink={1} minWidth={0} height={1} overflow="hidden">
            <text fg={settled ? muted : undefined} attributes={props.selected ? TextAttributes.BOLD : TextAttributes.NONE} wrapMode="none">{title}</text>
          </box>
          {card.state === 'pending' ? (
            <box flexShrink={100} minWidth={0} height={1} overflow="hidden"><text fg={muted} wrapMode="none">{card.name}</text></box>
          ) : null}
        </>
      )}
    >
      {card.state === 'pending' ? <text fg={muted} wrapMode="word">Move this session there? Its history stays here.</text> : null}
      {keyHint ? <text fg={muted} wrapMode="none">{keyHint}</text> : null}
    </Collapsible>
  );
}
