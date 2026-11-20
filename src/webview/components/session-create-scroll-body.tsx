import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import { useScrollCue } from "./menu-list";

/** Scroll container that fades its bottom edge only while rows are hidden below. */
export function ScrollBody({ children, className }: { children: ReactNode; className?: string }) {
  const { ref, more, onScroll } = useScrollCue();

  return (
    <div className={cn("relative", className)}>
      <div ref={ref} onScroll={onScroll} className="h-full overflow-x-hidden overflow-y-auto">
        {children}
      </div>
      <div
        aria-hidden
        data-more-below={more}
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-popover to-transparent transition-opacity",
          more ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}
