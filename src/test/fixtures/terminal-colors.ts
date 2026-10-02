import type { TerminalColorsLike } from '../../tui/ui/tokens/derive-tokens';

const ANSI = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];

export const DARK: TerminalColorsLike = { palette: ANSI, defaultForeground: '#d4d4d4', defaultBackground: '#1e1e1e' };
export const LIGHT: TerminalColorsLike = { palette: ANSI, defaultForeground: '#333333', defaultBackground: '#ffffff' };
