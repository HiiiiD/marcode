/**
 * A percentage as an SVG arc. `percent === undefined` means "not reported"
 * and renders a dashed track — deliberately distinct from a real 0%, which
 * renders an empty solid track.
 */
export function Ring({
  percent, size = 18, className,
}: { percent?: number; size?: number; className?: string }) {
  const stroke = 2.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;
  const known = percent !== undefined && Number.isFinite(percent);
  const clamped = known ? Math.max(0, Math.min(100, percent)) : 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className={className}
    >
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        strokeDasharray={known ? undefined : '2 2'}
        // `muted` is the panel's own widget background, so a track drawn in
        // it is invisible against the surface it sits on and the ring reads
        // as a floating arc with no scale behind it. The track has to be a
        // grey the background is not, in light and dark alike.
        className="stroke-muted-foreground/30"
      />
      {known && (
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(circumference * clamped) / 100} ${circumference}`}
          transform={`rotate(-90 ${center} ${center})`}
          className={clamped >= 80 ? 'stroke-destructive' : 'stroke-primary'}
        />
      )}
    </svg>
  );
}
