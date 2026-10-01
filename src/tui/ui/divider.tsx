import { useRenderer } from '@opentui/react';
import type { DividerRect } from '../../client-core/pane-geometry';
import { useTheme } from './termcn/hooks/use-theme';

export function Divider(props: { rect: DividerRect; onGrab(): void }) {
  const { rect } = props;
  const theme = useTheme();
  const renderer = useRenderer();
  const glyph = rect.axis === 'x' ? '│' : '─';
  const line = rect.axis === 'x' ? Array.from({ length: rect.h }, () => glyph).join('\n') : glyph.repeat(rect.w);
  return (
    <box
      position="absolute" left={rect.x} top={rect.y} width={rect.w} height={rect.h}
      onMouseOver={() => { renderer.setMousePointer(rect.axis === 'x' ? 'col-resize' : 'row-resize'); }}
      onMouseOut={() => { renderer.setMousePointer('default'); }}
      onMouseDown={(e) => { e.stopPropagation(); props.onGrab(); }}
    >
      <text fg={theme.colors.mutedForeground}>{line}</text>
    </box>
  );
}
