import { useEffect, useState } from 'react';

/**
 * Below this width the split can only stack — `PaneGroup` forces vertical
 * orientation and `SessionPicker` disables the orientation toggle.
 */
export const NARROW_PX = 500;

/**
 * Below this width the fleet diff surface is not offered at all.
 *
 * A file list with churn counts and session chips needs room to be scannable;
 * in a 300px column it is a wall of truncated paths, which is the failure
 * this threshold exists to prevent rather than to style around.
 */
export const REVIEW_PX = 700;

/**
 * The measured width of the element behind `ref`.
 *
 * There is exactly one call site — `App`, against the panel root — and every
 * threshold is derived from the number it returns. Each consumer used to run
 * its own `ResizeObserver` against its own root element; because
 * `contentRect` is a content-box measurement and those roots carry different
 * padding, they could disagree by 16-32px near a threshold — one reporting
 * narrow while the other did not, for the same actual panel width. One
 * observer on one element makes that disagreement structurally impossible
 * rather than merely unlikely, and that property is why a second threshold
 * is derived here instead of getting a second hook.
 *
 * `0` before the first measurement. Each threshold decides for itself what
 * that means: `App` reads narrow as `width > 0 && width < NARROW_PX` so an
 * unmeasured panel is not narrow (what the old boolean hook did), while
 * `width >= REVIEW_PX` already refuses to offer review until something has
 * measured. Both are the conservative reading of a width nobody has taken.
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
