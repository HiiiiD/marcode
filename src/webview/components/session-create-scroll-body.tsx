import { cn } from "@/lib/utils";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/** Scroll container that fades its bottom edge only while rows are hidden below. */
export function ScrollBody({ children, watch, className }: { children: ReactNode; watch: unknown; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (el) {
      setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
    }
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) {
      observer.observe(el.firstElementChild);
    }
    return () => observer.disconnect();
  }, [measure, watch]);

  return (
    <div className={cn("relative", className)}>
      <div ref={ref} onScroll={measure} className="h-full overflow-x-hidden overflow-y-auto">
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
