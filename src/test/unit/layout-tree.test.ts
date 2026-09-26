import * as assert from 'assert';
import {
  emptyRoot, flattenLeaves, leafSessionIds, findPath, slotCount,
  splitAt, assignAt, removeSession, replaceLeafSession, fillShape, stripSessionIds,
  at, replaceAt, freshTargetPath, emptySession, fillShapeKeepingOverflow, gridDims, removeSlotAt, placeSession, gridLayout, swapLeaves,
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

  test('returns undefined, does not throw, for a path that runs through a leaf', () => {
    const root = { kind: 'leaf' as const, sessionId: 'a', size: 100 };
    assert.strictEqual(assignAt(root, [0], 'b'), undefined);
  });

  test('returns undefined, does not throw, for an out-of-range index', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [{ kind: 'leaf' as const, sessionId: null, size: 100 }],
    };
    assert.strictEqual(assignAt(root, [5], 'b'), undefined);
  });

  test('returns undefined, does not throw, when the target already holds a session', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: 'b', size: 50 },
      ],
    };
    assert.strictEqual(assignAt(root, [1], 'c'), undefined);
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

  test('at returns undefined, rather than throwing, for a stale/invalid path', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: 'b', size: 50 },
      ],
    };
    // Runs through a leaf: 'a' has no children to descend into.
    assert.strictEqual(at(root, [0, 0]), undefined);
    // Out-of-range index at the top level.
    assert.strictEqual(at(root, [5]), undefined);
    // Out-of-range index one level deeper.
    const nested = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [root, { kind: 'leaf' as const, sessionId: 'c', size: 50 }],
    };
    assert.strictEqual(at(nested, [0, 5]), undefined);
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

suite('layout-tree freshTargetPath', () => {
  test('dragging backward (target ordinal < dragged ordinal) needs no index adjustment', () => {
    // Three top-level siblings: a(0), b(1), c(2). Dragging c onto a — the
    // target's ordinal (0) is already less than the dragged session's own
    // ordinal (2), so `adjusted` must stay exactly the target's own index,
    // never decremented.
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 34 },
        { kind: 'leaf' as const, sessionId: 'b', size: 33 },
        { kind: 'leaf' as const, sessionId: 'c', size: 33 },
      ],
    };
    const withoutDragged = removeSession(root, 'c');
    const path = freshTargetPath(root, [0], 'c', withoutDragged);
    assert.deepStrictEqual(path, [0]);
    assert.deepStrictEqual(at(withoutDragged, path!), { kind: 'leaf', sessionId: 'a', size: 50 });
  });

  test('removing the dragged leaf shifts a sibling subtree\'s indices, and the target is one of the shifted leaves', () => {
    // Top-level siblings: dragged(0), split(leafC, leafD)(1), leafE(2).
    // Removing `dragged` (a direct top-level child, one of 3+ siblings)
    // filters the parent's children down to 2 rather than collapsing —
    // the nested split shifts from index 1 to index 0, and so do its own
    // children's leading path segments.
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'dragged', size: 34 },
        {
          kind: 'split' as const, orientation: 'horizontal' as const, size: 33,
          children: [
            { kind: 'leaf' as const, sessionId: 'leafC', size: 50 },
            { kind: 'leaf' as const, sessionId: 'leafD', size: 50 },
          ],
        },
        { kind: 'leaf' as const, sessionId: 'leafE', size: 33 },
      ],
    };
    const withoutDragged = removeSession(root, 'dragged');
    // leafD's path before removal is [1, 1].
    const path = freshTargetPath(root, [1, 1], 'dragged', withoutDragged);
    // After removal, the split holding leafC/leafD shifted from index 1 to
    // index 0 — leafD's fresh path must reflect that shift, not the stale
    // pre-removal one.
    assert.deepStrictEqual(path, [0, 1]);
    assert.deepStrictEqual(at(withoutDragged, path!), { kind: 'leaf', sessionId: 'leafD', size: 50 });
  });

  test('returns undefined when the dragged session or the target has vanished', () => {
    const root = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: 'b', size: 50 },
      ],
    };
    assert.strictEqual(freshTargetPath(root, [0], 'z', root), undefined);
    assert.strictEqual(freshTargetPath(root, [9], 'a', root), undefined);
  });
});

const L = (sessionId: string | null, size = 50) => ({ kind: 'leaf' as const, sessionId, size });
const S = (orientation: 'vertical' | 'horizontal', children: ReturnType<typeof L>[] | unknown[], size = 100) =>
  ({ kind: 'split' as const, orientation, size, children }) as import('../../webview/components/layout-tree').LayoutNode;

suite('layout-tree emptySession', () => {
  test('empties the leaf without collapsing or reflowing siblings', () => {
    const root = S('vertical', [L('a', 30), L('b', 70)]);
    assert.deepStrictEqual(emptySession(root, 'a'), S('vertical', [L(null, 30), L('b', 70)]));
  });

  test('unknown id is a no-op', () => {
    const root = S('vertical', [L('a'), L('b')]);
    assert.strictEqual(emptySession(root, 'z'), root);
  });
});

suite('layout-tree removeSlotAt', () => {
  test('collapses a two-child split into the survivor', () => {
    const root = S('vertical', [L(null), L('b')]);
    assert.deepStrictEqual(removeSlotAt(root, [0]), L('b', 100));
  });

  test('reflows three siblings evenly', () => {
    const root = S('horizontal', [L('a', 20), L(null, 30), L('c', 50)]);
    const next = removeSlotAt(root, [1]);
    assert.deepStrictEqual(leafSessionIds(next), ['a', 'c']);
    assert.deepStrictEqual(flattenLeaves(next).map((l) => l.size), [50, 50]);
  });

  test('refuses to remove an occupied leaf and a root leaf', () => {
    const root = S('vertical', [L('a'), L('b')]);
    assert.strictEqual(removeSlotAt(root, [0]), root);
    const single = L(null, 100);
    assert.strictEqual(removeSlotAt(single, []), single);
  });
});

suite('layout-tree placeSession', () => {
  test('fills the first empty leaf in reading order', () => {
    const root = S('horizontal', [L('a'), S('vertical', [L('b'), L(null)], 50), L(null)]);
    const next = placeSession(root, 'n', null, 'vertical');
    assert.deepStrictEqual(leafSessionIds(next), ['a', 'b', 'n']);
    assert.strictEqual(flattenLeaves(next).find((l) => l.sessionId === 'n')!.path.join(), '1,1');
  });

  test('already placed session is a no-op', () => {
    const root = S('vertical', [L('a'), L(null)]);
    assert.strictEqual(placeSession(root, 'a', null, 'vertical'), root);
  });

  test('overflow adds a sibling after the focused pane and resizes all evenly', () => {
    const root = S('horizontal', [L('a', 30), L('b', 70)]);
    const next = placeSession(root, 'n', 'a', 'vertical');
    assert.deepStrictEqual(leafSessionIds(next), ['a', 'n', 'b']);
    assert.strictEqual(next.kind === 'split' && next.orientation, 'horizontal');
    assert.deepStrictEqual(flattenLeaves(next).map((l) => Math.round(l.size)), [33, 33, 33]);
  });

  test('a vertical parent stays vertical, sizes even', () => {
    const next = placeSession(S('vertical', [L('a'), L('b')]), 'n', 'b', 'horizontal');
    assert.strictEqual(next.kind === 'split' && next.orientation, 'vertical');
    assert.deepStrictEqual(leafSessionIds(next), ['a', 'b', 'n']);
    assert.strictEqual(slotCount(next), 3);
  });

  test('root leaf with no parent uses the fallback orientation', () => {
    const next = placeSession(L('a', 100), 'n', 'a', 'horizontal');
    assert.strictEqual(next.kind === 'split' && next.orientation, 'horizontal');
  });

  test('unknown or missing focus falls back to the last leaf', () => {
    const root = S('vertical', [L('a'), L('b')]);
    assert.deepStrictEqual(leafSessionIds(placeSession(root, 'n', 'ghost', 'vertical')), ['a', 'b', 'n']);
    assert.deepStrictEqual(leafSessionIds(placeSession(root, 'n', null, 'vertical')), ['a', 'b', 'n']);
  });
});

suite('layout-tree gridLayout', () => {
  test('1x1 is a single leaf', () => {
    assert.deepStrictEqual(gridLayout(1, 1, ['a']).root, L('a', 100));
  });

  test('1 row is a horizontal split, 1 col a vertical one', () => {
    const row = gridLayout(1, 3, []).root;
    assert.strictEqual(row.kind === 'split' && row.orientation, 'horizontal');
    const col = gridLayout(3, 1, []).root;
    assert.strictEqual(col.kind === 'split' && col.orientation, 'vertical');
  });

  test('2x3 is vertical rows of horizontal cells with even sizes', () => {
    const { root } = gridLayout(2, 3, []);
    assert.strictEqual(root.kind === 'split' && root.orientation, 'vertical');
    assert.strictEqual(slotCount(root), 6);
    assert.deepStrictEqual(flattenLeaves(root).map((l) => Math.round(l.size)), [33, 33, 33, 33, 33, 33]);
    assert.strictEqual(root.kind === 'split' && root.children[0].size, 50);
  });

  test('sessions fill cells in reading order, rest empty, none hidden', () => {
    const { root, hidden } = gridLayout(2, 2, ['a', 'b', 'c']);
    assert.deepStrictEqual(flattenLeaves(root).map((l) => l.sessionId), ['a', 'b', 'c', null]);
    assert.deepStrictEqual(hidden, []);
  });

  test('overflow sessions are reported hidden, last ones', () => {
    const { root, hidden } = gridLayout(1, 2, ['a', 'b', 'c', 'd']);
    assert.deepStrictEqual(leafSessionIds(root), ['a', 'b']);
    assert.deepStrictEqual(hidden, ['c', 'd']);
  });
});

suite('layout-tree swapLeaves', () => {
  test('swaps two occupied leaves in place', () => {
    const root = S('vertical', [L('a'), S('horizontal', [L('b'), L('c')], 50)]);
    assert.deepStrictEqual(leafSessionIds(swapLeaves(root, [0], [1, 1])), ['c', 'b', 'a']);
  });

  test('stale path is a no-op', () => {
    const root = S('vertical', [L('a'), L('b')]);
    assert.strictEqual(swapLeaves(root, [0], [5]), root);
  });
});

suite('layout-tree fillShapeKeepingOverflow', () => {
  test('fills what fits and reports the rest, in reading order', () => {
    const shape = S('horizontal', [L(null), L(null)]);
    const { root, hidden } = fillShapeKeepingOverflow(shape, ['a', 'b', 'c']);
    assert.deepStrictEqual(leafSessionIds(root), ['a', 'b']);
    assert.deepStrictEqual(hidden, ['c']);
  });
});

suite('layout-tree gridDims', () => {
  test('reads back what gridLayout built', () => {
    for (const [r, c] of [[1, 1], [1, 3], [3, 1], [2, 3], [4, 2]]) {
      assert.deepStrictEqual(gridDims(gridLayout(r, c, []).root), { rows: r, cols: c });
    }
  });

  test('a vertical stack of leaves is N rows, one column', () => {
    assert.deepStrictEqual(gridDims(S('vertical', [L('a'), L('b')])), { rows: 2, cols: 1 });
  });

  test('a non-grid shape has no dims', () => {
    const root = S('horizontal', [L('a'), S('vertical', [L('b'), L('c')], 50)]);
    assert.strictEqual(gridDims(root), undefined);
  });
});

suite('layout-tree overflow slots', () => {
  test('a slot created by overflow disappears when its session closes', () => {
    const root = S('vertical', [L('a'), L('b')]);
    const placed = placeSession(root, 'n', 'a', 'horizontal');
    const closed = emptySession(placed, 'n');
    assert.deepStrictEqual(leafSessionIds(closed), ['a', 'b']);
    assert.strictEqual(slotCount(closed), 2);
  });

  test('closing the session that was there first keeps its slot, only the overflow slot is transient', () => {
    const placed = placeSession(S('vertical', [L('a'), L('b')]), 'n', 'a', 'horizontal');
    const closed = emptySession(placed, 'a');
    assert.deepStrictEqual(flattenLeaves(closed).map((l) => l.sessionId), [null, 'n', 'b']);
  });

  test('a builder slot stays after its session closes', () => {
    const closed = emptySession(gridLayout(1, 2, ['a', 'b']).root, 'b');
    assert.strictEqual(slotCount(closed), 2);
  });

  test('filling an empty slot never marks it transient', () => {
    const next = placeSession(S('vertical', [L('a'), L(null)]), 'n', null, 'vertical');
    assert.strictEqual(slotCount(emptySession(next, 'n')), 2);
  });
});
