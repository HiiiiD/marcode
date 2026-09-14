import * as assert from 'assert';
import {
  emptyRoot, flattenLeaves, leafSessionIds, findPath, slotCount,
  splitAt, assignAt, removeSession, replaceLeafSession, fillShape, stripSessionIds,
  at, replaceAt,
} from '../../webview/components/layout-tree';

suite('layout-tree read helpers', () => {
  test('emptyRoot is a single null leaf', () => {
    assert.deepStrictEqual(emptyRoot(), { kind: 'leaf', sessionId: null, size: 100 });
  });

  test('flattenLeaves walks depth-first, recording each leaf\'s path', () => {
    const root = {
      kind: 'split' as const, orientation: 'horizontal' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        {
          kind: 'split' as const, orientation: 'vertical' as const, size: 50,
          children: [
            { kind: 'leaf' as const, sessionId: 'b', size: 50 },
            { kind: 'leaf' as const, sessionId: null, size: 50 },
          ],
        },
      ],
    };
    assert.deepStrictEqual(flattenLeaves(root), [
      { sessionId: 'a', path: [0], size: 50 },
      { sessionId: 'b', path: [1, 0], size: 50 },
      { sessionId: null, path: [1, 1], size: 50 },
    ]);
  });

  test('leafSessionIds skips empty leaves', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: null, size: 50 },
      ],
    };
    assert.deepStrictEqual(leafSessionIds(root), ['a']);
  });

  test('findPath locates a session, returns undefined when absent', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: 'b', size: 50 },
      ],
    };
    assert.deepStrictEqual(findPath(root, 'b'), [1]);
    assert.strictEqual(findPath(root, 'z'), undefined);
  });

  test('slotCount counts every leaf, empty or not', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: null, size: 50 },
      ],
    };
    assert.strictEqual(slotCount(root), 2);
  });
});

suite('layout-tree splitAt', () => {
  test('replaces the leaf at path with a 50/50 split of the two sessions', () => {
    const root = { kind: 'leaf' as const, sessionId: 'a', size: 100 };
    const next = splitAt(root, [], 'horizontal', 'b');
    assert.deepStrictEqual(next, {
      kind: 'split', orientation: 'horizontal', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: 'b', size: 50 },
      ],
    });
  });

  test('splits a leaf nested inside an existing split', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: 'b', size: 50 },
      ],
    };
    const next = splitAt(root, [1], 'horizontal', 'c');
    assert.deepStrictEqual(next, {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        {
          kind: 'split', orientation: 'horizontal', size: 50,
          children: [
            { kind: 'leaf', sessionId: 'b', size: 50 },
            { kind: 'leaf', sessionId: 'c', size: 50 },
          ],
        },
      ],
    });
  });
});

suite('layout-tree assignAt', () => {
  test('sets an empty leaf\'s sessionId in place, no structural change', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: null, size: 50 },
      ],
    };
    const next = assignAt(root, [1], 'b');
    assert.deepStrictEqual(next, {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: 'b', size: 50 },
      ],
    });
  });
});

suite('layout-tree at/replaceAt', () => {
  test('at walks a path down to the target node', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: 'b', size: 50 },
      ],
    };
    assert.deepStrictEqual(at(root, [1]), { kind: 'leaf', sessionId: 'b', size: 50 });
    assert.deepStrictEqual(at(root, []), root);
  });

  test('replaceAt swaps the node at path, leaving siblings\' size untouched', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: 'b', size: 50 },
      ],
    };
    const next = replaceAt(root, [1], { kind: 'leaf', sessionId: 'c', size: 50 });
    assert.deepStrictEqual(next, {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: 'c', size: 50 },
      ],
    });
  });

  test('replaceAt at an empty path replaces the whole tree', () => {
    const root = { kind: 'leaf' as const, sessionId: 'a', size: 100 };
    const next = replaceAt(root, [], { kind: 'leaf', sessionId: 'b', size: 100 });
    assert.deepStrictEqual(next, { kind: 'leaf', sessionId: 'b', size: 100 });
  });
});

suite('layout-tree removeSession', () => {
  test('a leaf at the tree root becomes an empty leaf', () => {
    const root = { kind: 'leaf' as const, sessionId: 'a', size: 100 };
    assert.deepStrictEqual(removeSession(root, 'a'), { kind: 'leaf', sessionId: null, size: 100 });
  });

  test('removing one of two siblings collapses the split to the survivor', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 30 },
        { kind: 'leaf' as const, sessionId: 'b', size: 70 },
      ],
    };
    // Collapse takes the survivor's role in the grandparent, sized 100 —
    // matches the old evenlySizedPanes behavior of never preserving a
    // departing sibling's proportions.
    assert.deepStrictEqual(removeSession(root, 'a'), { kind: 'leaf', sessionId: 'b', size: 100 });
  });

  test('removing one of three siblings reflows the remaining two evenly, no collapse', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 20 },
        { kind: 'leaf' as const, sessionId: 'b', size: 30 },
        { kind: 'leaf' as const, sessionId: 'c', size: 50 },
      ],
    };
    assert.deepStrictEqual(removeSession(root, 'a'), {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'b', size: 50 },
        { kind: 'leaf', sessionId: 'c', size: 50 },
      ],
    });
  });

  test('collapsing a nested split preserves the survivor at its grandparent slot, sized by the grandparent', () => {
    const root = {
      kind: 'split' as const, orientation: 'horizontal' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        {
          kind: 'split' as const, orientation: 'vertical' as const, size: 50,
          children: [
            { kind: 'leaf' as const, sessionId: 'b', size: 60 },
            { kind: 'leaf' as const, sessionId: 'c', size: 40 },
          ],
        },
      ],
    };
    assert.deepStrictEqual(removeSession(root, 'b'), {
      kind: 'split', orientation: 'horizontal', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: 'c', size: 50 },
      ],
    });
  });

  test('removing a session not present is a no-op', () => {
    const root = { kind: 'leaf' as const, sessionId: 'a', size: 100 };
    assert.deepStrictEqual(removeSession(root, 'z'), root);
  });
});

suite('layout-tree replaceLeafSession', () => {
  test('swaps one leaf\'s sessionId, no structural change', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 40 },
        { kind: 'leaf' as const, sessionId: 'b', size: 60 },
      ],
    };
    assert.deepStrictEqual(replaceLeafSession(root, 'a', 'z'), {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'z', size: 40 },
        { kind: 'leaf', sessionId: 'b', size: 60 },
      ],
    });
  });
});

suite('layout-tree fillShape', () => {
  test('fills leaves depth-first with the given ids, extras left empty', () => {
    const shape = {
      kind: 'split' as const, orientation: 'horizontal' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: null, size: 50 },
        { kind: 'leaf' as const, sessionId: null, size: 50 },
      ],
    };
    assert.deepStrictEqual(fillShape(shape, ['a']), {
      kind: 'split', orientation: 'horizontal', size: 100,
      children: [
        { kind: 'leaf', sessionId: 'a', size: 50 },
        { kind: 'leaf', sessionId: null, size: 50 },
      ],
    });
  });

  test('returns undefined when there are more sessions than slots', () => {
    const shape = { kind: 'leaf' as const, sessionId: null, size: 100 };
    assert.strictEqual(fillShape(shape, ['a', 'b']), undefined);
  });
});

suite('layout-tree stripSessionIds', () => {
  test('produces the same shape with every leaf emptied', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: 'b', size: 50 },
      ],
    };
    assert.deepStrictEqual(stripSessionIds(root), {
      kind: 'split', orientation: 'vertical', size: 100,
      children: [
        { kind: 'leaf', sessionId: null, size: 50 },
        { kind: 'leaf', sessionId: null, size: 50 },
      ],
    });
  });
});
