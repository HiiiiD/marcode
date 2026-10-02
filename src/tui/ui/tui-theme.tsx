import { useMemo, type ReactNode } from 'react';
import { defaultTheme } from './termcn/lib/terminal-themes/default';
import { createTheme, ThemeProvider } from './termcn/providers/theme-provider';
import { useTokens } from './tokens/tokens-provider';
import type { TuiTokens } from './tokens/derive-tokens';

// Named terminal colours, never hex, so a light terminal theme keeps every token legible.
const named = {
  ...defaultTheme.colors,
  primary: 'cyan', accent: 'cyan', info: 'cyan',
  success: 'green', warning: 'yellow', error: 'red',
  muted: 'gray', mutedForeground: 'gray', border: 'gray',
};

export const tuiTheme = createTheme({ name: 'marcode', colors: named });

// Secondary text and rules come from the terminal's own foreground/background mix once it is known.
const themeFor = (tokens: TuiTokens | undefined) => (tokens
  ? createTheme({ name: 'marcode', colors: { ...named, muted: tokens.textMuted, mutedForeground: tokens.textMuted, border: tokens.menu } })
  : tuiTheme);

export function TuiThemeProvider({ children }: { children: ReactNode }) {
  const tokens = useTokens();
  const theme = useMemo(() => themeFor(tokens), [tokens]);
  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
}
