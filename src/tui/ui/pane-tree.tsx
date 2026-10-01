import type { BoxRenderable, MouseEvent } from '@opentui/core';
import { useRenderer } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';
import type { LayoutNode } from '../../client-core/layout-tree';
import { visibleRects, MIN_PANE_H, MIN_PANE_W, type DividerRect, type Rect } from '../../client-core/pane-geometry';
import { dragDivider } from '../../client-core/pane-resize';
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
  onFork(id: SessionId, itemId: string): void;
  onResize(root: LayoutNode): void;
  onOpenPicker?(kind: PickerKind): void;
}

export function PaneTree(p: PaneTreeProps) {
  const { state } = useTuiStore();
  const theme = useTheme();
  const renderer = useRenderer();
  const region = useRef<BoxRenderable | null>(null);
  const [size, setSize] = useState(p.estimate);
  useEffect(() => {
    const r = region.current;
    if (r && r.width > 0 && r.height > 0 && (r.width !== size.w || r.height !== size.h)) { setSize({ w: r.width, h: r.height }); }
  });
  const [drag, setDrag] = useState<LayoutNode | null>(null);
  const dragged = useRef<LayoutNode | null>(null);
  const grabbed = useRef<DividerRect | null>(null);
  const grabRoot = useRef<LayoutNode | null>(null);
  const area: Rect = { x: 0, y: 0, w: size.w, h: size.h };
  const root = state.layout.root;
  const rootRef = useRef(root);
  rootRef.current = root;
  const { panes, dividers } = visibleRects(drag ?? root, p.focusedId, area, p.maximized);

  // The renderer only captures a drag once the first drag event lands, wherever the pointer is by then,
  // so the grab is remembered here and the drag is read from the region, which every pane's events bubble to.
  const onDrag = (e: MouseEvent) => {
    const d = grabbed.current;
    if (!d) { return; }
    const origin = region.current;
    const pointer = d.axis === 'x' ? e.x - (origin?.x ?? 0) : e.y - (origin?.y ?? 0);
    const next = dragDivider(root, d, pointer);
    dragged.current = next === root ? null : next;
    setDrag(dragged.current);
  };
  // A drag the renderer stopped reporting (pointer left the window) must not commit on someone else's later click.
  const cancelDrag = () => { grabbed.current = null; dragged.current = null; setDrag(null); };
  const onPress = cancelDrag;
  // A drag measured against a tree that has since changed would write that old tree back over the change.
  useEffect(() => { if (grabbed.current && grabRoot.current !== root) { cancelDrag(); } }, [root]);
  const onEnd = () => {
    renderer.setMousePointer('default');
    grabbed.current = null;
    const done = dragged.current;
    dragged.current = null;
    setDrag(null);
    if (done && grabRoot.current === rootRef.current) { p.onResize(done); }
  };
  return (
    <box ref={region} onMouseDown={onPress} onMouseDrag={onDrag} onMouseUp={onEnd} onMouseDragEnd={onEnd} position="relative" overflow="hidden" flexGrow={1} flexShrink={1} minHeight={0} minWidth={0}>
      {panes.map((r) => (r.sessionId === null ? (
        <box key={r.path.join('.')} position="absolute" left={r.x} top={r.y} width={r.w} height={r.h} border borderStyle="single" borderColor={theme.colors.border}>
          <text fg={theme.colors.mutedForeground}>open a session from the roster</text>
        </box>
      ) : (
        <Pane
          key={r.path.join('.')} rect={{ ...r, sessionId: r.sessionId }}
          compact={r.sessionId !== p.focusedId && (r.w < MIN_PANE_W || r.h < MIN_PANE_H)}
          focused={r.sessionId === p.focusedId} liveZone={p.liveZone}
          onFocus={p.onFocus} onHide={p.onHide} onFork={p.onFork} onOpenPicker={p.onOpenPicker}
        />
      )))}
      {dividers.map((d) => <Divider key={`${d.path.join('.')}:${d.index}`} rect={d} onGrab={() => { grabbed.current = d; grabRoot.current = rootRef.current; }} />)}
    </box>
  );
}
