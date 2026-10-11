import * as assert from 'node:assert';
import { parseTheme, THEME_KEYS } from '../../shared/theme-settings';

suite('theme-settings: parseTheme', () => {
  test('absent theme is empty with no warnings', () => {
    assert.deepStrictEqual(parseTheme(undefined), { theme: {}, warnings: [] });
  });

  test('non-object theme is empty with one warning', () => {
    for (const raw of ['#fff', ['#fff'], null, 3]) {
      const r = parseTheme(raw);
      assert.deepStrictEqual(r.theme, {});
      assert.strictEqual(r.warnings.length, 1);
    }
  });

  test('accepts #rrggbb and #rgb, normalised to lowercase #rrggbb', () => {
    const { theme, warnings } = parseTheme({ background: '#1E1E2E', primary: '#abc' });
    assert.deepStrictEqual(theme, { background: '#1e1e2e', primary: '#aabbcc' });
    assert.deepStrictEqual(warnings, []);
  });

  test('drops invalid values and names the key', () => {
    const bad = {
      muted: 'red', border: 'rgb(1,2,3)', focus: '#12345', card: '#gggggg', popover: '#11223344', hover: 5,
      element: '#fff;}</style><script>',
    };
    const { theme, warnings } = parseTheme(bad);
    assert.deepStrictEqual(theme, {});
    assert.strictEqual(warnings.length, Object.keys(bad).length);
    for (const key of Object.keys(bad)) {
      assert.strictEqual(warnings.some((w) => w.includes(`theme.${key}`)), true);
    }
  });

  test('drops unknown keys with a warning and keeps the valid ones', () => {
    const { theme, warnings } = parseTheme({ primry: '#ffffff', primary: '#000000' });
    assert.deepStrictEqual(theme, { primary: '#000000' });
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].includes('theme.primry'), true);
  });

  test('every documented key is accepted', () => {
    const all = Object.fromEntries(THEME_KEYS.map((k) => [k, '#010203']));
    const { theme, warnings } = parseTheme(all);
    assert.strictEqual(Object.keys(theme).length, THEME_KEYS.length);
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(THEME_KEYS.length, 42);
  });
});
