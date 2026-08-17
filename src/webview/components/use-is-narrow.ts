import { useEffect, useState } from 'react';

/**
 * Below this width the split can only stack — `PaneGroup` forces vertical
 * orientation and `SessionPicker` disables the orientation toggle.
 */
export const NARROW_PX = 500;

/**
 * The measured width of the element behind `ref`.
 *
 * There is exactly one call site — `App`, against the panel root — and
 * `NARROW_PX` is derived from the number it returns. Each consumer used to
 * run its own `ResizeObserver` against its own root element; because
 * `contentRect` is a content-box measurement and those roots carry different
 * padding, they could disagree by 16-32px near the threshold — one reporting
 * narrow while the other did not, for the same actual panel width. One
 * observer on one element makes that disagreement structurally impossible
 * rather than merely unlikely.
 *
 * `0` before the first measurement. `App` reads narrow as
 * `width > 0 && width < NARROW_PX` so an unmeasured panel is not narrow —
 * what the old boolean hook did, and the conservative reading of a width
 * nobody has taken.
 */
export function usePanelWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) { return; }
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
