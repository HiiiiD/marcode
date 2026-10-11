import { expect, test } from 'bun:test';
import { themeFor, tuiTheme } from '../../tui/ui/tui-theme';
import { deriveTokens } from '../../tui/ui/tokens/derive-tokens';
import { DARK } from '../fixtures/terminal-colors';

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

test('themed accents reach the termcn theme', () => {
  const t = themeFor(deriveTokens(DARK, {
    primary: '#3366ff', added: '#00ff00', modified: '#ffff00', danger: '#ff0000', focus: '#ff00ff', border: '#222222',
  }));
  expect(t.colors.primary).toBe('#3366ff');
  expect(t.colors.accent).toBe('#3366ff');
  expect(t.colors.info).toBe('#3366ff');
  expect(t.colors.success).toBe('#00ff00');
  expect(t.colors.warning).toBe('#ffff00');
  expect(t.colors.error).toBe('#ff0000');
  expect(t.colors.focusRing).toBe('#ff00ff');
  expect(t.colors.border).toBe('#222222');
});

test('without overrides the accents stay named terminal colours', () => {
  const t = themeFor(deriveTokens(DARK));
  expect(t.colors.primary).toBe('cyan');
  expect(t.colors.success).toBe('green');
  expect(t.colors.error).toBe('red');
});
