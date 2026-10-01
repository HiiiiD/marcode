import type { ReactNode } from 'react';
import { defaultTheme } from './termcn/lib/terminal-themes/default';
import { createTheme, ThemeProvider } from './termcn/providers/theme-provider';

// Named terminal colours, never hex, so a light terminal theme keeps every token legible.
export const tuiTheme = createTheme({
  name: 'marcode',
  colors: {
    ...defaultTheme.colors,
    primary: 'cyan', accent: 'cyan', info: 'cyan',
    success: 'green', warning: 'yellow', error: 'red',
    muted: 'gray', mutedForeground: 'gray', border: 'gray',
  },
});

export function TuiThemeProvider({ children }: { children: ReactNode }) {
  return <ThemeProvider theme={tuiTheme}>{children}</ThemeProvider>;
}
