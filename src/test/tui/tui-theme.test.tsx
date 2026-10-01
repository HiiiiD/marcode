import { expect, test } from 'bun:test';
import { tuiTheme } from '../../tui/ui/tui-theme';

const NAMED = new Set(['gray', 'cyan', 'yellow', 'red', 'green', 'magenta', 'blue']);
// Tokens read by the installed components (confirm, dialog, tag, tool-call, chat-message).
const USED = ['primary', 'accent', 'success', 'warning', 'error', 'info', 'muted', 'mutedForeground', 'border'] as const;

test('every token an installed component reads is a named terminal colour', () => {
  const bad = USED.filter((k) => !NAMED.has(tuiTheme.colors[k]));
  expect(bad).toEqual([]);
});

test('the theme is named for Marcode', () => {
  expect(tuiTheme.name).toBe('marcode');
});
