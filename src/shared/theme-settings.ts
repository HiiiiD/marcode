export const THEME_KEYS = [
  'background', 'foreground', 'muted', 'border', 'focus',
  'pane', 'paneActive', 'card', 'popover', 'element', 'hover',
  'primary', 'primaryForeground', 'secondaryForeground', 'danger', 'dangerForeground',
  'added', 'modified', 'deleted', 'renamed',
  'diffAddedBg', 'diffRemovedBg', 'diffContextBg', 'diffAddedLineNumberBg', 'diffRemovedLineNumberBg',
  'diffLineNumber', 'diffAddedSign', 'diffRemovedSign',
  'syntaxComment', 'syntaxKeyword', 'syntaxString', 'syntaxNumber', 'syntaxFunction',
  'syntaxType', 'syntaxOperator', 'syntaxVariable', 'syntaxPunctuation',
  'markdownHeading', 'markdownLink', 'markdownCode', 'markdownQuote', 'markdownStrong',
] as const;

export type ThemeKey = (typeof THEME_KEYS)[number];
export type ThemeColors = Partial<Record<ThemeKey, string>>;

const KEYS: ReadonlySet<string> = new Set(THEME_KEYS);
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function normalizeHex(value: unknown): string | undefined {
  const m = typeof value === 'string' ? HEX.exec(value.trim()) : null;
  if (!m) { return undefined; }
  const h = m[1].toLowerCase();
  return '#' + (h.length === 3 ? [...h].map((c) => c + c).join('') : h);
}

export function parseTheme(raw: unknown): { theme: ThemeColors; warnings: string[] } {
  if (raw === undefined) { return { theme: {}, warnings: [] }; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { theme: {}, warnings: ['config.json: theme is not an object; using no theme.'] };
  }
  const theme: Record<string, string> = {};
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!KEYS.has(key)) { warnings.push(`config.json: ignoring unknown theme.${key}.`); continue; }
    const hex = normalizeHex(value);
    if (hex) { theme[key] = hex; } else { warnings.push(`config.json: theme.${key} is not a #rgb or #rrggbb color; ignoring it.`); }
  }
  return { theme: theme as ThemeColors, warnings };
}
