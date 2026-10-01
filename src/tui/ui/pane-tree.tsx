import type { BoxRenderable } from '@opentui/core';
import { useEffect, useRef, useState } from 'react';
import { visibleRects, MIN_PANE_H, MIN_PANE_W, type Rect } from '../../client-core/pane-geometry';
import type { SessionId } from '../../protocol/messages';
import type { PickerKind } from '../view/pickers';
import { Divider } from './divider';
import { Pane } from './pane';
import { useTuiStore } from './store';
import { useTheme } from './termcn/hooks/use-theme';

export interface PaneTreeProps {
  /** Cells the region is expected to get before it has been measured. */
  estimate: { w: number; h: number };
  focusedId: SessionId | null;
  liveZone: 'composer' | 'transcript' | null;
  maximized: boolean;
  onFocus(id: SessionId): void;
  onHide(id: SessionId): void;
  onOpenPicker?(kind: PickerKind): void;
}

export function PaneTree(p: PaneTreeProps) {
  const { state } = useTuiStore();
  const theme = useTheme();
  const region = useRef<BoxRenderable | null>(null);
  const [size, setSize] = useState(p.estimate);
  useEffect(() => {
    const r = region.current;
    if (r && r.width > 0 && r.height > 0 && (r.width !== size.w || r.height !== size.h)) { setSize({ w: r.width, h: r.height }); }
  });
  const area: Rect = { x: 0, y: 0, w: size.w, h: size.h };
  const root = state.layout.root;
  const { panes, dividers } = visibleRects(root, p.focusedId, area, p.maximized);
  return (
    <box ref={region} position="relative" overflow="hidden" flexGrow={1} flexShrink={1} minHeight={0} minWidth={0}>
      {panes.map((r) => (r.sessionId === null ? (
        <box key={r.path.join('.')} position="absolute" left={r.x} top={r.y} width={r.w} height={r.h} border borderStyle="single" borderColor={theme.colors.border}>
          <text fg={theme.colors.mutedForeground}>open a session from the roster</text>
        </box>
      ) : (
        <Pane
          key={r.path.join('.')} rect={{ ...r, sessionId: r.sessionId }}
          compact={r.w < MIN_PANE_W || r.h < MIN_PANE_H}
          focused={r.sessionId === p.focusedId} liveZone={p.liveZone}
          onFocus={p.onFocus} onHide={p.onHide} onOpenPicker={p.onOpenPicker}
        />
      )))}
      {dividers.map((d) => <Divider key={`${d.path.join('.')}:${d.index}`} rect={d} />)}
    </box>
  );
}
