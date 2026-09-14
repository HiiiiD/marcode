import * as assert from 'assert';
import {
  accessibleTitles, leafDisplayState, reconcilePaneLayout, rosterSessionIds, visibleLeaves,
} from '../../webview/components/pane-layout';
import type { LayoutNode } from '../../webview/components/layout-tree';

suite('pane-layout rosterSessionIds', () => {
  // Deliberately does NOT filter out `archived: true`: only `delete-session`
  // removes a session from the roster entirely, and an archived session the
  // user has explicitly opened must keep its leaf.
  test('every session id, archived or not', () => {
    const ids = rosterSessionIds([{ id: 'a', archived: false }, { id: 'b', archived: true }]);
    assert.deepStrictEqual([...ids], ['a', 'b']);
  });

  test('reflects exactly the roster, not a subset of it', () => {
    const ids = rosterSessionIds([{ id: 'x', archived: false }]);
    assert.deepStrictEqual([...ids], ['x']);
  });

  test('an empty roster yields an empty set', () => {
    assert.deepStrictEqual([...rosterSessionIds([])], []);
  });
});

suite('pane-layout leafDisplayState', () => {
  const roster = new Set(['a']);
  const arrived = new Set(['a']);

  test('null sessionId is empty', () => {
    assert.strictEqual(leafDisplayState(null, roster, arrived), 'empty');
  });

  test('a session not yet in the roster/byId is pending', () => {
    assert.strictEqual(leafDisplayState('z', roster, arrived), 'pending');
  });

  test('a session in both roster and byId is ready', () => {
    assert.strictEqual(leafDisplayState('a', roster, arrived), 'ready');
  });

  test('a session removed from the roster but still awaiting reconcile is pending, not ready', () => {
    assert.strictEqual(leafDisplayState('a', new Set(), arrived), 'pending');
  });

  test('a session in the roster but whose snapshot has not arrived is pending', () => {
    assert.strictEqual(leafDisplayState('a', roster, new Set()), 'pending');
  });
});

suite('pane-layout visibleLeaves', () => {
  test('tags each leaf with its display state, path preserved', () => {
    const root: LayoutNode = {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: null, size: 50 },
      ],
    };
    const result = visibleLeaves(root, new Set(['a']), new Set(['a']));
    assert.deepStrictEqual(result, [
      { sessionId: 'a', path: [0], size: 50, state: 'ready' },
      { sessionId: null, path: [1], size: 50, state: 'empty' },
    ]);
  });

  test('a leaf whose session has not arrived yet is tagged pending', () => {
    const root: LayoutNode = { kind: 'leaf', sessionId: 'a', size: 100 };
    const result = visibleLeaves(root, new Set(['a']), new Set());
    assert.deepStrictEqual(result, [{ sessionId: 'a', path: [], size: 100, state: 'pending' }]);
  });
});

suite('pane-layout reconcilePaneLayout', () => {
  test('drops a leaf whose session left the roster outright, collapsing its split', () => {
    const root: LayoutNode = {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: 'b', size: 50 },
      ],
    };
    const result = reconcilePaneLayout(root, new Set(['a']), ['a'], new Set(['a']));
    assert.deepStrictEqual(result.root, { kind: 'leaf', sessionId: 'a', size: 100 });
  });

  test('appends a newly-arrived session as a sibling at the top split level', () => {
    const root: LayoutNode = { kind: 'leaf', sessionId: 'a', size: 100 };
    const result = reconcilePaneLayout(root, new Set(['a', 'b']), ['a', 'b'], new Set(['a']));
    assert.deepStrictEqual(result.root, {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: 'b', size: 50 },
      ],
    });
    assert.ok(result.knownSessionIds.has('b'), 'newly-appended session must be marked known');
  });

  test('fills a bare empty root directly, without wrapping it in a split', () => {
    const root: LayoutNode = { kind: 'leaf', sessionId: null, size: 100 };
    const result = reconcilePaneLayout(root, new Set(['a']), ['a'], new Set());
    assert.deepStrictEqual(result.root, { kind: 'leaf', sessionId: 'a', size: 100 });
  });

  // A session the user explicitly unchecked (its leaf removed) must not
  // reappear on the very next reconcile pass just because it's still live
  // and still has a byId snapshot — knownSessionIds is what remembers that
  // it was already offered a leaf once.
  test('a session the user explicitly unchecked never comes back once known', () => {
    const root: LayoutNode = { kind: 'leaf', sessionId: null, size: 100 };
    const result = reconcilePaneLayout(root, new Set(['a']), ['a'], new Set(['a']));
    assert.strictEqual(result.root, null);
  });

  test('returns null when nothing needs to change', () => {
    const root: LayoutNode = { kind: 'leaf', sessionId: 'a', size: 100 };
    const result = reconcilePaneLayout(root, new Set(['a']), ['a'], new Set(['a']));
    assert.strictEqual(result.root, null);
  });

  test('does not append a session whose snapshot has not arrived yet', () => {
    const root: LayoutNode = { kind: 'leaf', sessionId: null, size: 100 };
    const result = reconcilePaneLayout(root, new Set(['a']), [], new Set());
    assert.strictEqual(result.root, null);
  });

  test('appends a third sibling to an existing vertical split, reflowing all children evenly', () => {
    const root: LayoutNode = {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: 'b', size: 50 },
      ],
    };
    const result = reconcilePaneLayout(root, new Set(['a', 'b', 'c']), ['a', 'b', 'c'], new Set(['a', 'b']));
    assert.deepStrictEqual(result.root, {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 100 / 3 },
        { kind: 'leaf', sessionId: 'b', size: 100 / 3 },
        { kind: 'leaf', sessionId: 'c', size: 100 / 3 },
      ],
    });
  });

  test('wraps a non-vertical top split rather than merging into it', () => {
    const root: LayoutNode = {
      kind: 'split', orientation: 'horizontal', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: 'b', size: 50 },
      ],
    };
    const result = reconcilePaneLayout(root, new Set(['a', 'b', 'c']), ['a', 'b', 'c'], new Set(['a', 'b']));
    assert.deepStrictEqual(result.root, {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        {
          kind: 'split', orientation: 'horizontal', size: 50,
          children: [
            { kind: 'leaf', sessionId: 'a', size: 50 },
            { kind: 'leaf', sessionId: 'b', size: 50 },
          ],
        },
        { kind: 'leaf', sessionId: 'c', size: 50 },
      ],
    });
  });
});

suite('pane-layout accessibleTitles', () => {
  test('a unique title passes through unchanged', () => {
    const names = accessibleTitles([{ id: 'a', title: 'Session a' }, { id: 'b', title: 'Session b' }]);
    assert.strictEqual(names.get('a'), 'Session a');
    assert.strictEqual(names.get('b'), 'Session b');
  });

  test('disambiguates a title collision with the id, leaves uniques alone', () => {
    const names = accessibleTitles([{ id: '1', title: 'Untitled' }, { id: '2', title: 'Untitled' }, { id: '3', title: 'fix bug' }]);
    assert.strictEqual(names.get('1'), 'Untitled (1)');
    assert.strictEqual(names.get('2'), 'Untitled (2)');
    assert.strictEqual(names.get('3'), 'fix bug');
    assert.notStrictEqual(names.get('1'), names.get('2'));
  });

  test('an empty list yields an empty map', () => {
    assert.deepStrictEqual([...accessibleTitles([])], []);
  });
});
