import { useEffect, useState } from 'react';

/**
 * Below this width the split can only stack — `PaneGroup` forces vertical
 * orientation and `SessionPicker` disables the orientation toggle.
 */
export const NARROW_PX = 500;

/**
 * Tracks whether the element behind `ref` is narrower than `NARROW_PX`.
 *
 * There is exactly one call site for this hook — `App`, against the panel
 * root — and `narrow` is passed down to `SessionPicker` and `PaneGroup` as
 * a prop. Each of those used to run its own `ResizeObserver` against its
 * own root element; because `contentRect` is a content-box measurement and
 * the two roots carry different padding, they could disagree by 16-32px
 * near the threshold — one reporting `narrow` while the other did not, for
 * the same actual panel width. A single observer on a single element makes
 * that disagreement structurally impossible rather than merely unlikely.
 */
export function useIsNarrow(ref: React.RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) { return; }
    const observer = new ResizeObserver(([entry]) => {
      setNarrow(entry.contentRect.width < NARROW_PX);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return narrow;
}
