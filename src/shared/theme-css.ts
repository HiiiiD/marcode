import type { ThemeColors, ThemeKey } from './theme-settings';

// Later keys overwrite earlier ones on the same variable, so `pane` beats `background`.
const VARS: ReadonlyArray<readonly [ThemeKey, readonly string[]]> = [
  ['background', ['--background']],
  ['pane', ['--background']],
  ['foreground', ['--foreground', '--card-foreground', '--popover-foreground', '--accent-foreground']],
  ['muted', ['--muted-foreground']],
  ['border', ['--border']],
  ['focus', ['--ring']],
  ['card', ['--card', '--muted']],
  ['popover', ['--popover']],
  ['element', ['--secondary']],
  ['hover', ['--accent']],
  ['primary', ['--primary']],
  ['primaryForeground', ['--primary-foreground']],
  ['secondaryForeground', ['--secondary-foreground']],
  ['danger', ['--destructive']],
  ['dangerForeground', ['--destructive-foreground']],
  ['added', ['--git-added']],
  ['modified', ['--git-modified']],
  ['deleted', ['--git-deleted']],
  ['renamed', ['--git-renamed']],
];

export function themeToCss(theme: ThemeColors): string {
  const decls = new Map<string, string>();
  for (const [key, names] of VARS) {
    const value = theme[key];
    if (value) { for (const name of names) { decls.set(name, value); } }
  }
  if (decls.size === 0) { return ''; }
  return `:root{${[...decls].map(([n, v]) => `${n}:${v}`).join(';')}}`;
}
