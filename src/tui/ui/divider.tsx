import { useEffect, useRef, useState } from 'react';
import type { DividerRect } from '../../client-core/pane-geometry';
import { useTheme } from './termcn/hooks/use-theme';

export function Divider(props: { rect: DividerRect; active: boolean; onGrab(): void }) {
  const { rect } = props;
  const theme = useTheme();
  const [hover, setHover] = useState(false);
  // The renderer sends no mouse-out while a drag holds the pointer, so a finished drag clears the hover itself.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !props.active) { setHover(false); }
    wasActive.current = props.active;
  }, [props.active]);
  const lit = hover || props.active;
  const glyph = rect.axis === 'x' ? (lit ? '┃' : '│') : (lit ? '━' : '─');
  const line = rect.axis === 'x' ? Array.from({ length: rect.h }, () => glyph).join('\n') : glyph.repeat(rect.w);
  return (
    <box
      position="absolute" left={rect.x} top={rect.y} width={rect.w} height={rect.h}
      onMouseOver={() => { setHover(true); }}
      onMouseOut={() => { setHover(false); }}
      onMouseDown={(e) => { e.stopPropagation(); props.onGrab(); }}
    >
      <text fg={lit ? theme.colors.primary : theme.colors.mutedForeground}>{line}</text>
    </box>
  );
}
