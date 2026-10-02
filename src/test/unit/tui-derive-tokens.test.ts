import * as assert from 'node:assert';
import { maxDelta, parseHex } from '../../tui/ui/tokens/color';
import { deriveTokens, type TerminalColorsLike } from '../../tui/ui/tokens/derive-tokens';
import { DARK, LIGHT } from '../fixtures/terminal-colors';

const rgb = (hex: string) => parseHex(hex)!;

suite('tui tokens: deriveTokens', () => {
  test('dark terminal: surfaces step toward the foreground and stay ordered', () => {
    const t = deriveTokens(DARK)!;
    const bg = rgb('#1e1e1e');
    assert.ok(maxDelta(rgb(t.panel), bg) >= 8);
    assert.ok(maxDelta(rgb(t.element), bg) > maxDelta(rgb(t.panel), bg));
    assert.ok(maxDelta(rgb(t.menu), bg) > maxDelta(rgb(t.element), bg));
    assert.ok(rgb(t.panel)[0] > bg[0]);
  });

  test('light terminal: surfaces step toward the (darker) foreground', () => {
    const t = deriveTokens(LIGHT)!;
    assert.ok(rgb(t.panel)[0] < 255);
    assert.ok(maxDelta(rgb(t.panel), rgb('#ffffff')) >= 8);
  });

  test('diff tints are visibly distinct from the panel on both polarities', () => {
    for (const colors of [DARK, LIGHT]) {
      const t = deriveTokens(colors)!;
      assert.ok(maxDelta(rgb(t.diff.addedBg), rgb(t.diff.contextBg)) >= 8);
      assert.ok(maxDelta(rgb(t.diff.removedBg), rgb(t.diff.contextBg)) >= 8);
      assert.notStrictEqual(t.diff.addedBg, t.diff.removedBg);
    }
  });

  test('missing palette slots fall back to standard ANSI values instead of throwing', () => {
    const t = deriveTokens({ ...DARK, palette: [] });
    assert.ok(t !== undefined);
    assert.match(t.syntax.keyword, /^#[0-9a-f]{6}$/);
  });

  test('null or non-hex default colors yield undefined', () => {
    assert.strictEqual(deriveTokens({ ...DARK, defaultBackground: null }), undefined);
    assert.strictEqual(deriveTokens({ ...DARK, defaultForeground: 'rgb:zz/zz/zz' }), undefined);
  });

  test('foreground too close to background yields undefined', () => {
    const same: TerminalColorsLike = { ...DARK, defaultForeground: '#202020', defaultBackground: '#1e1e1e' };
    assert.strictEqual(deriveTokens(same), undefined);
    assert.strictEqual(deriveTokens({ ...DARK, defaultForeground: '#1e1e1e' }), undefined);
  });

  test('every token is a #rrggbb string', () => {
    const t = deriveTokens(DARK)!;
    const all = [t.panel, t.menu, t.element, t.text, t.textMuted, ...Object.values(t.diff), ...Object.values(t.syntax), ...Object.values(t.markdown)];
    assert.deepStrictEqual(all.filter((v) => !/^#[0-9a-f]{6}$/.test(v)), []);
  });
});
