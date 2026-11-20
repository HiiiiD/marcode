import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { cn } from '@/lib/utils';

/** Tracks whether a scroll container has more below, to fade its bottom edge. */
export function useScrollCue() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = ref.current;
    if (el) { setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4); }
  }, []);
  useEffect(measure);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') { return; }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) { observer.observe(el.firstElementChild); }
    return () => observer.disconnect();
  }, [measure]);
  return { ref, more, onScroll: measure };
}

export const menuListClass = (more: boolean) => cn(
  'max-h-44 w-full scroll-pb-5 overflow-y-auto overscroll-contain',
  more && '[mask-image:linear-gradient(to_bottom,black_calc(100%-16px),transparent)]',
);

export function MenuGroupLabel({ children }: { children: ReactNode }) {
  return <p aria-hidden className="px-1.5 pt-1.5 pb-0.5 text-[0.65rem] text-muted-foreground">{children}</p>;
}

/** One single-line row: name, then a muted detail on the same line. */
export function MenuRow({ id, active, title, label, detail, rowRef, onPick }: {
  id: string;
  active: boolean;
  title: string;
  label: string;
  detail?: string;
  rowRef?: Ref<HTMLDivElement>;
  onPick: () => void;
}) {
  return (
    <div
      ref={rowRef}
      id={id}
      role="option"
      aria-selected={active}
      title={title}
      onMouseDown={(e) => { e.preventDefault(); onPick(); }}
      className={cn(
        'flex h-7 cursor-pointer items-baseline gap-2 rounded-md px-1.5 py-1 text-xs',
        // twMerge cannot merge across variants: a hover fill on the active row would outrank its bg.
        active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
      )}
    >
      <span className="max-w-[60%] shrink-0 truncate font-medium">{label}</span>
      {detail && (
        <span className={cn('min-w-0 flex-1 truncate text-muted-foreground', active && 'text-accent-foreground/70')}>
          {detail}
        </span>
      )}
    </div>
  );
}
