import { useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { MAX_GRID_DIM } from '../../client-core/layout-apply';

interface Cell { rows: number; cols: number }

const ARROWS: Record<string, [number, number]> = {
  ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0],
};

/** "Table size" picker: the cell under the pointer or focus sets rows x columns, a click applies it. */
export function LayoutSizePicker({ current, onPick }: { current: Cell | null; onPick: (rows: number, cols: number) => void }) {
  const [active, setActive] = useState<Cell | null>(null);
  const shown = active ?? current;
  const tab = shown ?? { rows: 1, cols: 1 };

  const onKeyDown = (e: KeyboardEvent, rows: number, cols: number) => {
    const delta = ARROWS[e.key];
    if (!delta) { return; }
    e.preventDefault();
    const r = Math.min(MAX_GRID_DIM, Math.max(1, rows + delta[0]));
    const c = Math.min(MAX_GRID_DIM, Math.max(1, cols + delta[1]));
    setActive({ rows: r, cols: c });
    document.getElementById(`layout-cell-${r}-${c}`)?.focus();
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="group"
        aria-label="Grid size"
        className="grid w-full gap-0.5"
        style={{ gridTemplateColumns: `repeat(${MAX_GRID_DIM}, minmax(0, 1fr))` }}
        onPointerLeave={() => setActive(null)}
      >
        {Array.from({ length: MAX_GRID_DIM * MAX_GRID_DIM }, (_, i) => {
          const rows = Math.floor(i / MAX_GRID_DIM) + 1;
          const cols = (i % MAX_GRID_DIM) + 1;
          const lit = shown !== null && rows <= shown.rows && cols <= shown.cols;
          return (
            <button
              key={i}
              id={`layout-cell-${rows}-${cols}`}
              type="button"
              tabIndex={rows === tab.rows && cols === tab.cols ? 0 : -1}
              aria-label={`${rows} ${rows === 1 ? 'row' : 'rows'} by ${cols} ${cols === 1 ? 'column' : 'columns'}`}
              onPointerEnter={() => setActive({ rows, cols })}
              onFocus={() => setActive({ rows, cols })}
              onKeyDown={(e) => onKeyDown(e, rows, cols)}
              onClick={() => onPick(rows, cols)}
              className={cn(
                'h-5 rounded-[3px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring',
                lit ? 'bg-primary/50' : 'bg-foreground/10 hover:bg-foreground/15',
              )}
            />
          );
        })}
      </div>
      <p className="text-muted-foreground tabular-nums" aria-live="polite">
        {shown ? `${shown.rows} × ${shown.cols}` : 'Pick a size'}
      </p>
    </div>
  );
}
