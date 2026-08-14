import { cn } from "@/lib/utils";
import { useRef, type KeyboardEventHandler, type ReactNode } from "react";
import type { EffortLevel } from "../../protocol/messages";

/**
 * What the row needs from whatever element it is rendered into. The two
 * call sites disagree about that element and cannot be made to agree: inside
 * the composer's mode menu the row has to be a menu ITEM, because the menu
 * owns roving focus and anything that is not an item is unreachable by the
 * arrow keys that got the user there; inside the create dialog there is no
 * menu at all, and a menu item there would claim a role nothing owns.
 */
export interface EffortRowProps {
  "aria-label": string;
  onKeyDown: KeyboardEventHandler;
  children: ReactNode;
}

/**
 * Effort as a scale you set in place, not a submenu you open: five levels
 * ordered low → max is a magnitude, and a magnitude is set faster by
 * pointing at a position than by opening a list and reading five words
 * ("xhigh" vs "max" carries no order in it).
 */
export function EffortSlider({
  levels,
  value,
  onChange,
  render,
}: {
  levels: EffortLevel[];
  value: EffortLevel;
  onChange: (level: EffortLevel) => void;
  /** The element the row renders into. See `EffortRowProps`. */
  render: (props: EffortRowProps) => ReactNode;
}) {
  const track = useRef<HTMLSpanElement | null>(null);
  /**
   * The track's box as it was when the drag started. Measuring per move
   * would read the layout the CURRENT value produced, so any width change
   * downstream of the value moves the dots out from under a pointer that
   * never left the row. Sizing the readout to its widest level (below)
   * already stops that shift, but a drag is the one interaction that cannot
   * survive being wrong even once, and one measurement per gesture is also
   * simply cheaper than one per move.
   */
  const dragBox = useRef<DOMRect | null>(null);
  const active = levels.indexOf(value);

  const step = (delta: number) => {
    const next = levels[Math.min(levels.length - 1, Math.max(0, active + delta))];
    if (next && next !== value) {
      onChange(next);
    }
  };

  /**
   * Nearest dot to the pointer, from the track's own box — the dots are
   * evenly spaced, so index `i` sits at `i / (n - 1)` of the width and
   * rounding the ratio lands on the one being pointed at. Rounding rather
   * than flooring is also what makes the two ends forgiving: the outer half
   * of each end dot's cell snaps to it.
   */
  const setFromX = (clientX: number) => {
    const box = dragBox.current ?? track.current?.getBoundingClientRect();
    if (!box || box.width === 0) {
      return;
    }
    const ratio = (clientX - box.left) / box.width;
    const i = Math.min(levels.length - 1, Math.max(0, Math.round(ratio * (levels.length - 1))));
    if (levels[i] !== value) {
      onChange(levels[i]);
    }
  };

  return render({
    // The accessible name carries the value because the host element is
    // never a real `role="slider"` — a control that announces "Effort" alone
    // would leave a screen-reader user arrowing blind.
    "aria-label": `Effort: ${value}. Left and right arrows change it.`,
    onKeyDown: (e) => {
      const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (delta !== 0) {
        // A vertical menu has no use for left/right of its own — but stop
        // the event reaching the popup anyway rather than relying on that,
        // since ArrowLeft closes a submenu one level up.
        e.preventDefault();
        e.stopPropagation();
        step(delta);
        return;
      }
      if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        e.stopPropagation();
        const end = e.key === "Home" ? levels[0] : levels[levels.length - 1];
        if (end !== value) {
          onChange(end);
        }
      }
    },
    children: (
      <>
        <span>Effort</span>
        <span
          ref={track}
          // py-2 for the hit area, not for the look: the dots themselves are
          // 8px, which is a target no one can hit in a sidebar.
          className="ml-auto flex cursor-pointer items-center gap-1.5 py-2"
          onPointerDown={(e) => {
            dragBox.current = e.currentTarget.getBoundingClientRect();
            e.currentTarget.setPointerCapture(e.pointerId);
            setFromX(e.clientX);
          }}
          onPointerMove={(e) => {
            // buttons is a bitmask of what is held down; 1 is the primary
            // button. Without it every hover over the track would set a level.
            if (e.buttons & 1) {
              setFromX(e.clientX);
            }
          }}
          onPointerUp={() => {
            dragBox.current = null;
          }}
          // Capture is released for us when the pointer is lost, but the
          // cached box has to go with it — a stale one would survive into the
          // next gesture and be measured against a row that has since moved.
          onPointerCancel={() => {
            dragBox.current = null;
          }}
          aria-hidden
        >
          {levels.map((level, i) => (
            <span
              key={level}
              className={cn(
                "size-2 rounded-full transition-colors",
                i <= active ? "bg-foreground" : "bg-foreground/20",
                i === active && "ring-2 ring-foreground/30",
              )}
            />
          ))}
        </span>
        {/*
          Every level stacked in ONE grid cell, with the inactive ones merely
          invisible: the box is then exactly as wide as this model's widest
          name, measured by the browser in the real font. It has to be
          reserved rather than fitted — the readout follows an `ml-auto`
          track, so a value that renders wider than the last one drags the
          dots leftward out from under the pointer that is setting them, which
          is why high → medium jumped.

          Reserved by measurement, not by arithmetic: `ch` is the advance of
          "0", so `6ch` is not the width of "medium" in a proportional face,
          and the levels come from the provider's catalog row anyway — a model
          can ship any names, in any number, at any length.
        */}
        <span className="grid justify-items-end">
          {levels.map((level) => (
            <span
              key={level}
              aria-hidden={level !== value}
              className={cn(
                "col-start-1 row-start-1 text-xs text-muted-foreground",
                level !== value && "invisible",
              )}
            >
              {level}
            </span>
          ))}
        </span>
      </>
    ),
  });
}
