import { luminance, maxDelta, mix, parseHex, toHex, type Rgb } from './color';

export interface TerminalColorsLike {
  palette: (string | null)[];
  defaultForeground: string | null;
  defaultBackground: string | null;
}

export interface TuiTokens {
  panel: string; element: string; menu: string;
  text: string; textMuted: string;
  diff: {
    addedBg: string; removedBg: string; contextBg: string;
    addedLineNumberBg: string; removedLineNumberBg: string;
    lineNumber: string; addedSign: string; removedSign: string;
  };
  syntax: {
    comment: string; keyword: string; string: string; number: string; function: string;
    type: string; operator: string; variable: string; punctuation: string;
  };
  markdown: { heading: string; link: string; code: string; quote: string; strong: string };
}

const XTERM = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
];
// Below this fg/bg gap no tint is readable; above it, MIN_STEP keeps each surface visibly off the background.
const MIN_CONTRAST = 96;
const MIN_STEP = 8;

export function deriveTokens(c: TerminalColorsLike): TuiTokens | undefined {
  const bg = parseHex(c.defaultBackground);
  const fg = parseHex(c.defaultForeground);
  if (!bg || !fg) { return undefined; }
  const gap = maxDelta(bg, fg);
  if (gap < MIN_CONTRAST) { return undefined; }

  const light = luminance(bg) > 0.5;
  const ansi = (i: number): Rgb => parseHex(c.palette[i]) ?? parseHex(XTERM[i])!;
  // Bright variants read well on dark terminals; on light ones the normal slot has the contrast.
  const hue = (normal: number): Rgb => ansi(light ? normal : normal + 8);
  const surface = (t: number): Rgb => mix(bg, fg, Math.max(t, MIN_STEP / gap));

  const panel = surface(0.06);
  const tint = (hueRgb: Rgb, base: Rgb, t: number): string => toHex(mix(base, hueRgb, t));
  const muted = mix(bg, fg, 0.55);

  return {
    panel: toHex(panel),
    element: toHex(surface(0.09)),
    menu: toHex(surface(0.12)),
    text: toHex(fg),
    textMuted: toHex(muted),
    diff: {
      contextBg: toHex(panel),
      addedBg: tint(ansi(2), panel, 0.2),
      removedBg: tint(ansi(1), panel, 0.2),
      addedLineNumberBg: tint(ansi(2), panel, 0.3),
      removedLineNumberBg: tint(ansi(1), panel, 0.3),
      lineNumber: toHex(muted),
      addedSign: toHex(hue(2)),
      removedSign: toHex(hue(1)),
    },
    syntax: {
      comment: toHex(muted),
      keyword: toHex(hue(5)),
      string: toHex(hue(2)),
      number: toHex(hue(3)),
      function: toHex(hue(4)),
      type: toHex(hue(6)),
      operator: toHex(hue(6)),
      variable: toHex(fg),
      punctuation: toHex(muted),
    },
    markdown: {
      heading: toHex(hue(4)),
      link: toHex(hue(6)),
      code: toHex(hue(2)),
      quote: toHex(muted),
      strong: toHex(fg),
    },
  };
}
