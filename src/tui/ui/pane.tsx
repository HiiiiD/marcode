import type { PaneRect } from '../../client-core/pane-geometry';
import type { SessionId } from '../../protocol/messages';
import { bottomSlot } from '../view/bottom-slot';
import type { PickerKind } from '../view/pickers';
import { BottomSlotView } from './bottom-slot';
import { paneTitleText, PaneTitle } from './pane-title';
import { useTuiStore } from './store';
import { Surface } from './surface';
import { useTheme } from './termcn/hooks/use-theme';
import { Transcript } from './transcript/transcript';

export interface PaneProps {
  rect: PaneRect & { sessionId: SessionId };
  compact: boolean;
  focused: boolean;
  liveZone: 'composer' | 'transcript' | null;
  onFocus(id: SessionId): void;
  onHide(id: SessionId): void;
  onFork(id: SessionId, itemId: string): void;
  onOpenPicker?(kind: PickerKind): void;
}

export function Pane({ rect, compact, focused, liveZone, onFocus, onHide, onFork, onOpenPicker }: PaneProps) {
  const { state } = useTuiStore();
  const theme = useTheme();
  const id = rect.sessionId;
  const pane = state.byId[id];
  const summary = pane?.summary ?? state.sessions.find((s) => s.id === id);
  const slot = bottomSlot(summary, pane);
  const needsYou = slot.kind === 'permission' || slot.kind === 'question';
  const title = paneTitleText(summary, id, needsYou);
  const place = { position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h } as const;
  if (compact) {
    return (
      <box {...place} onMouseDown={() => { onFocus(id); }}>
        <text fg={focused ? theme.colors.primary : theme.colors.mutedForeground} truncate>{title}</text>
      </box>
    );
  }
  return (
    <Surface
      {...place} flexDirection="column" padX={1} tone={focused ? 'paneActive' : 'pane'}
      fallbackBorder={focused ? theme.colors.primary : theme.colors.border}
      onMouseDown={() => { onFocus(id); }}
    >
      <PaneTitle text={title} focused={focused} onHide={() => { onHide(id); }} />
      <Transcript
        sessionId={id}
        focused={focused && liveZone === 'transcript'}
        relocationKeys={summary?.owner ? 'none' : focused ? 'live' : 'idle'}
        onFork={(itemId) => { onFork(id, itemId); }}
      />
      <box flexShrink={0}>
        <BottomSlotView sessionId={id} focused={focused && liveZone === 'composer'} onOpenPicker={onOpenPicker} />
      </box>
    </Surface>
  );
}
