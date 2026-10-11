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
    assert.ok(maxDelta(rgb(t.paneActive), bg) > maxDelta(rgb(t.pane), bg));
    assert.ok(maxDelta(rgb(t.panel), bg) > maxDelta(rgb(t.paneActive), bg));
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
    const all = [t.pane, t.paneActive, t.panel, t.menu, t.element, t.text, t.textMuted, ...Object.values(t.diff), ...Object.values(t.syntax), ...Object.values(t.markdown)];
    assert.deepStrictEqual(all.filter((v) => !/^#[0-9a-f]{6}$/.test(v)), []);
  });

  const NO_REPLY: TerminalColorsLike = { palette: [], defaultForeground: null, defaultBackground: null };

  test('no overrides, and an empty override object, give identical tokens', () => {
    assert.deepStrictEqual(deriveTokens(DARK, {}), deriveTokens(DARK));
    assert.strictEqual('primary' in deriveTokens(DARK, {})!, false);
  });

  test('a specific key beats its broad key beats the derived value', () => {
    const base = deriveTokens(DARK)!;
    const broad = deriveTokens(DARK, { added: '#00ff00' })!;
    assert.strictEqual(broad.syntax.string, '#00ff00');
    assert.strictEqual(broad.diff.addedSign, '#00ff00');
    assert.notStrictEqual(broad.diff.addedBg, base.diff.addedBg);
    const specific = deriveTokens(DARK, { added: '#00ff00', syntaxString: '#123456', diffAddedBg: '#0a0b0c' })!;
    assert.strictEqual(specific.syntax.string, '#123456');
    assert.strictEqual(specific.diff.addedBg, '#0a0b0c');
    assert.strictEqual(specific.diff.addedSign, '#00ff00');
  });

  test('surface keys replace the derived surfaces', () => {
    const t = deriveTokens(DARK, { pane: '#010101', paneActive: '#020202', card: '#030303', element: '#040404', popover: '#050505' })!;
    assert.deepStrictEqual([t.pane, t.paneActive, t.panel, t.element, t.menu], ['#010101', '#020202', '#030303', '#040404', '#050505']);
    assert.strictEqual(t.diff.contextBg, '#030303');
  });

  test('foreground, muted and primary flow to text, textMuted, markdown and syntax', () => {
    const t = deriveTokens(DARK, { foreground: '#eeeeee', muted: '#777777', primary: '#3366ff' })!;
    assert.strictEqual(t.text, '#eeeeee');
    assert.strictEqual(t.textMuted, '#777777');
    assert.strictEqual(t.syntax.comment, '#777777');
    assert.strictEqual(t.markdown.heading, '#3366ff');
    assert.strictEqual(t.markdown.link, '#3366ff');
    assert.strictEqual(t.syntax.function, '#3366ff');
    assert.strictEqual(t.primary, '#3366ff');
  });

  test('background + foreground overrides rescue a terminal that never answers', () => {
    assert.strictEqual(deriveTokens(NO_REPLY), undefined);
    const t = deriveTokens(NO_REPLY, { background: '#1e1e2e', foreground: '#cdd6f4' });
    assert.notStrictEqual(t, undefined);
    assert.strictEqual(t!.text, '#cdd6f4');
  });

  test('only accents on a terminal that never answers is still undefined', () => {
    assert.strictEqual(deriveTokens(NO_REPLY, { primary: '#3366ff' }), undefined);
  });

  test('an overridden background of the opposite polarity flips the surfaces', () => {
    const t = deriveTokens(DARK, { background: '#ffffff', foreground: '#000000' })!;
    assert.ok(rgb(t.panel)[0] < 255);
  });

  test('optional extras are only present when supplied', () => {
    const t = deriveTokens(DARK, { border: '#111111', focus: '#222222', danger: '#333333', modified: '#444444' })!;
    assert.deepStrictEqual([t.border, t.focus, t.danger, t.modified, t.added], ['#111111', '#222222', '#333333', '#444444', undefined]);
    assert.strictEqual('added' in t, false);
  });
});
