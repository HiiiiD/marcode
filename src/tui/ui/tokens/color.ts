export type Rgb = readonly [number, number, number];

export function parseHex(hex: string | null | undefined): Rgb | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) { return undefined; }
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const toHex = (c: Rgb): string =>
  '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

export const mix = (a: Rgb, b: Rgb, t: number): Rgb =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export const maxDelta = (a: Rgb, b: Rgb): number =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

export const luminance = (c: Rgb): number => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
