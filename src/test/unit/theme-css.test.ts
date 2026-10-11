import * as assert from 'node:assert';
import { themeToCss } from '../../shared/theme-css';

suite('theme-css: themeToCss', () => {
  test('an empty theme is the empty string', () => {
    assert.strictEqual(themeToCss({}), '');
  });

  test('keys with no webview counterpart emit nothing', () => {
    assert.strictEqual(themeToCss({ paneActive: '#111111', syntaxKeyword: '#222222', diffAddedBg: '#333333' }), '');
  });

  test('maps broad keys to the shadcn variables', () => {
    const css = themeToCss({ foreground: '#aaaaaa', card: '#bbbbbb', added: '#00ff00', danger: '#ff0000' });
    for (const decl of [
      '--foreground:#aaaaaa', '--card-foreground:#aaaaaa', '--popover-foreground:#aaaaaa', '--accent-foreground:#aaaaaa',
      '--card:#bbbbbb', '--muted:#bbbbbb', '--git-added:#00ff00', '--destructive:#ff0000',
    ]) {
      assert.strictEqual(css.includes(decl), true, decl);
    }
    assert.strictEqual(css.startsWith(':root{'), true);
    assert.strictEqual(css.endsWith('}'), true);
  });

  test('pane wins over background for --background', () => {
    const css = themeToCss({ background: '#111111', pane: '#222222' });
    assert.strictEqual(css.includes('--background:#222222'), true);
    assert.strictEqual(css.includes('--background:#111111'), false);
  });

  test('background alone sets --background', () => {
    assert.strictEqual(themeToCss({ background: '#111111' }), ':root{--background:#111111}');
  });
});
