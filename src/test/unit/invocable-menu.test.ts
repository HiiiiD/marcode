import * as assert from 'assert';
import {
  INVOCABLE_MENU_WINDOW, filterInvocables, insertionFor, menuKeyAction,
  menuQuery, menuView, nextIndex, truncateName,
} from '../../webview/lib/invocable-menu';
import type { Invocable } from '../../protocol/messages';

const ENTRIES: Invocable[] = [
  { name: 'brainstorming', description: 'Turn ideas into designs' },
  { name: 'superpowers:writing-plans', description: 'Plan before code', origin: 'superpowers' },
  { name: 'init', description: 'Brainstorming-adjacent bootstrap' },
  { name: 'loop', description: 'Run on an interval', argHint: '[interval] [prompt]' },
];

suite('invocable menu', () => {
  test('the menu opens only on a leading slash', () => {
    assert.strictEqual(menuQuery('/'), '');
    assert.strictEqual(menuQuery('/bra'), 'bra');
    assert.strictEqual(menuQuery(''), undefined);
    assert.strictEqual(menuQuery('hello'), undefined);
    assert.strictEqual(menuQuery('see src/foo'), undefined);
  });

  test('the menu closes once arguments begin', () => {
    // A space means the user is typing arguments, not choosing an entry —
    // and the composer needs Enter back at that point.
    assert.strictEqual(menuQuery('/loop '), undefined);
    assert.strictEqual(menuQuery('/loop 5m'), undefined);
    assert.strictEqual(menuQuery('/loop\n'), undefined);
  });

  test('name matches rank above description matches', () => {
    const out = filterInvocables(ENTRIES, 'brain');

    assert.deepStrictEqual(out.map((e) => e.name), ['brainstorming', 'init']);
  });

  test('an earlier match position ranks first, then alphabetical', () => {
    const entries: Invocable[] = [{ name: 'xxplan' }, { name: 'planner' }, { name: 'plan-b' }];
    const out = filterInvocables(entries, 'plan');

    assert.deepStrictEqual(out.map((e) => e.name), ['plan-b', 'planner', 'xxplan']);
  });

  test('matching is case-insensitive and searches the whole prefixed name', () => {
    const out = filterInvocables(ENTRIES, 'SUPERPOWERS:writing');

    assert.deepStrictEqual(out.map((e) => e.name), ['superpowers:writing-plans']);
  });

  test('an empty query returns everything in provider order', () => {
    const out = filterInvocables(ENTRIES, '');

    assert.deepStrictEqual(out.map((e) => e.name), ENTRIES.map((e) => e.name));
  });

  test('a query matching nothing returns an empty list', () => {
    assert.deepStrictEqual(filterInvocables(ENTRIES, 'zzz'), []);
  });

  test('the view caps rows and reports the overflow', () => {
    const many: Invocable[] = Array.from({ length: 200 }, (_, i) => ({ name: `cmd-${i}` }));
    const view = menuView(many, '');

    assert.strictEqual(view.rows.length, INVOCABLE_MENU_WINDOW);
    assert.strictEqual(view.overflow, 200 - INVOCABLE_MENU_WINDOW);
  });

  test('a filtered view under the cap reports no overflow', () => {
    const view = menuView(ENTRIES, 'loop');

    assert.strictEqual(view.rows.length, 1);
    assert.strictEqual(view.overflow, 0);
  });

  test('insertion is the verbatim name with a trailing space', () => {
    assert.deepStrictEqual(insertionFor({ name: 'superpowers:writing-plans' }), {
      text: '/superpowers:writing-plans ', ghost: '',
    });
  });

  test('an arg hint becomes ghost text, never part of the inserted text', () => {
    const out = insertionFor({ name: 'loop', argHint: '[interval] [prompt]' });

    assert.strictEqual(out.text, '/loop ');
    assert.strictEqual(out.ghost, '[interval] [prompt]');
  });

  test('long names truncate in the middle, keeping prefix and leaf', () => {
    const out = truncateName('document-skills:some-very-long-skill-name-here', 24);

    // 24 = 12 head chars + the ellipsis + 11 tail chars.
    assert.strictEqual(out.length, 24);
    assert.ok(out.startsWith('document-'));
    assert.ok(out.endsWith('name-here'));
    assert.ok(out.includes('…'));
  });

  test('a short name is returned unchanged', () => {
    assert.strictEqual(truncateName('init', 24), 'init');
  });

  test('the menu claims only its own keys', () => {
    assert.strictEqual(menuKeyAction('ArrowDown'), 'move-down');
    assert.strictEqual(menuKeyAction('ArrowUp'), 'move-up');
    assert.strictEqual(menuKeyAction('Enter'), 'select');
    assert.strictEqual(menuKeyAction('Tab'), 'select');
    assert.strictEqual(menuKeyAction('Escape'), 'close');
    assert.strictEqual(menuKeyAction('a'), 'pass');
    assert.strictEqual(menuKeyAction('Backspace'), 'pass');
  });

  test('the highlight wraps at both ends', () => {
    assert.strictEqual(nextIndex(0, 1, 3), 1);
    assert.strictEqual(nextIndex(2, 1, 3), 0);
    assert.strictEqual(nextIndex(0, -1, 3), 2);
    assert.strictEqual(nextIndex(0, 1, 0), 0);
  });
});
