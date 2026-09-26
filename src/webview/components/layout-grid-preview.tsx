import { cn } from '@/lib/utils';

interface LayoutGridPreviewProps {
  rows: number;
  cols: number;
  /** How many leading cells are filled by an open session. */
  filled: number;
}

export function LayoutGridPreview({ rows, cols, filled }: LayoutGridPreviewProps) {
  return (
    <div
      role="img"
      aria-label={`${rows} rows by ${cols} columns, ${rows * cols} slots`}
      className="grid h-20 gap-0.5 rounded-md border border-border bg-muted/40 p-0.5"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}
    >
      {Array.from({ length: rows * cols }, (_, i) => (
        <div
          key={i}
          className={cn('rounded-sm border', i < filled ? 'border-primary/60 bg-primary/25' : 'border-dashed border-border')}
        />
      ))}
    </div>
  );
}
