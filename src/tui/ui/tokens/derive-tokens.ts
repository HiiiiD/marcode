import type { ThemeColors } from '../../../shared/theme-settings';
import { luminance, maxDelta, mix, parseHex, toHex, type Rgb } from './color';

export interface TerminalColorsLike {
  palette: (string | null)[];
  defaultForeground: string | null;
  defaultBackground: string | null;
}

export interface TuiTokens {
  pane: string; paneActive: string; panel: string; element: string; menu: string;
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
  // Present only when the user themed them; the TUI otherwise keeps its named terminal colours.
  border?: string; focus?: string; primary?: string; danger?: string; added?: string; modified?: string;
}

const XTERM = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
];
// Below this fg/bg gap no tint is readable; above it, MIN_STEP keeps each surface visibly off the background.
const MIN_CONTRAST = 96;
const MIN_STEP = 8;

export function deriveTokens(c: TerminalColorsLike, o: ThemeColors = {}): TuiTokens | undefined {
  const bg = parseHex(o.background ?? c.defaultBackground);
  const fg = parseHex(o.foreground ?? c.defaultForeground);
  if (!bg || !fg) { return undefined; }
  const gap = maxDelta(bg, fg);
  if (gap < MIN_CONTRAST) { return undefined; }

  const light = luminance(bg) > 0.5;
  const ansi = (i: number): Rgb => parseHex(c.palette[i]) ?? parseHex(XTERM[i])!;
  // Bright variants read well on dark terminals; on light ones the normal slot has the contrast.
  const hue = (normal: number): string => toHex(ansi(light ? normal : normal + 8));
  const surface = (t: number): Rgb => mix(bg, fg, Math.max(t, MIN_STEP / gap));

  // Unrounded when derived, so unthemed tints stay byte-identical to the pre-theme output.
  const panel = parseHex(o.card) ?? surface(0.095);
  const panelHex = toHex(panel);
  const tint = (hueRgb: Rgb, t: number): string => toHex(mix(panel, hueRgb, t));
  const mutedHex = o.muted ?? toHex(mix(bg, fg, 0.55));
  const fgHex = toHex(fg);
  const addedRgb = parseHex(o.added) ?? ansi(2);
  const deletedRgb = parseHex(o.deleted) ?? ansi(1);
  const extras: Partial<TuiTokens> = {};
  for (const k of ['border', 'focus', 'primary', 'danger', 'added', 'modified'] as const) {
    if (o[k]) { extras[k] = o[k]; }
  }

  return {
    pane: o.pane ?? toHex(surface(0.03)),
    paneActive: o.paneActive ?? toHex(surface(0.065)),
    panel: panelHex,
    element: o.element ?? toHex(surface(0.125)),
    menu: o.popover ?? toHex(surface(0.155)),
    text: fgHex,
    textMuted: mutedHex,
    diff: {
      contextBg: o.diffContextBg ?? panelHex,
      addedBg: o.diffAddedBg ?? tint(addedRgb, 0.2),
      removedBg: o.diffRemovedBg ?? tint(deletedRgb, 0.2),
      addedLineNumberBg: o.diffAddedLineNumberBg ?? tint(addedRgb, 0.3),
      removedLineNumberBg: o.diffRemovedLineNumberBg ?? tint(deletedRgb, 0.3),
      lineNumber: o.diffLineNumber ?? mutedHex,
      addedSign: o.diffAddedSign ?? o.added ?? hue(2),
      removedSign: o.diffRemovedSign ?? o.deleted ?? hue(1),
    },
    syntax: {
      comment: o.syntaxComment ?? mutedHex,
      keyword: o.syntaxKeyword ?? hue(5),
      string: o.syntaxString ?? o.added ?? hue(2),
      number: o.syntaxNumber ?? o.modified ?? hue(3),
      function: o.syntaxFunction ?? o.primary ?? hue(4),
      type: o.syntaxType ?? hue(6),
      operator: o.syntaxOperator ?? hue(6),
      variable: o.syntaxVariable ?? fgHex,
      punctuation: o.syntaxPunctuation ?? mutedHex,
    },
    markdown: {
      heading: o.markdownHeading ?? o.primary ?? hue(4),
      link: o.markdownLink ?? o.primary ?? hue(6),
      code: o.markdownCode ?? o.added ?? hue(2),
      quote: o.markdownQuote ?? mutedHex,
      strong: o.markdownStrong ?? fgHex,
    },
    ...extras,
  };
}
