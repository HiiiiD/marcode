import * as assert from 'assert';
import {
  evenlySizedPanes, reconcilePaneLayout, visiblePanes,
} from '../../webview/components/pane-layout';

suite('pane-layout evenlySizedPanes', () => {
  test('splits size evenly across ids', () => {
    const layout = evenlySizedPanes(['a', 'b', 'c', 'd'], 'vertical');
    assert.strictEqual(layout.panes.length, 4);
    assert.ok(layout.panes.every((p) => p.size === 25));
  });

  test('falls back to 100 for an empty id list rather than dividing by zero', () => {
    const layout = evenlySizedPanes([], 'horizontal');
    assert.deepStrictEqual(layout.panes, []);
  });
});

suite('pane-layout visiblePanes', () => {
  test('keeps only panes that are both eligible and have a snapshot', () => {
    const panes = [{ sessionId: 'a', size: 50 }, { sessionId: 'b', size: 50 }];
    const result = visiblePanes(panes, new Set(['a', 'b']), new Set(['a']));
    assert.deepStrictEqual(result.map((p) => p.sessionId), ['a']);
  });

  test('drops a pane whose session was archived (still in byId, no longer eligible)', () => {
    const panes = [{ sessionId: 'a', size: 100 }];
    const result = visiblePanes(panes, new Set([]), new Set(['a']));
    assert.deepStrictEqual(result, []);
  });

  test('drops a pane whose session snapshot has not arrived yet', () => {
    const panes = [{ sessionId: 'a', size: 100 }];
    const result = visiblePanes(panes, new Set(['a']), new Set([]));
    assert.deepStrictEqual(result, []);
  });

  test('drops a pane whose session was deleted outright (absent from the roster)', () => {
    const panes = [{ sessionId: 'a', size: 100 }, { sessionId: 'b', size: 0 }];
    // 'b' still lingers in byId (never cleaned up client-side) but is gone
    // from the roster entirely, unlike an archived session.
    const result = visiblePanes(panes, new Set(['a']), new Set(['a', 'b']));
    assert.deepStrictEqual(result.map((p) => p.sessionId), ['a']);
  });
});

suite('pane-layout reconcilePaneLayout', () => {
  test('returns null when the layout already matches the roster', () => {
    const layout = { orientation: 'vertical' as const, panes: [{ sessionId: 'a', size: 100 }] };
    const result = reconcilePaneLayout(layout, new Set(['a']), ['a']);
    assert.strictEqual(result, null);
  });

  test('appends a newly live session not yet present in the layout', () => {
    const layout = { orientation: 'vertical' as const, panes: [{ sessionId: 'a', size: 100 }] };
    const result = reconcilePaneLayout(layout, new Set(['a', 'b']), ['a', 'b']);
    assert.ok(result);
    assert.deepStrictEqual(result!.panes.map((p) => p.sessionId), ['a', 'b']);
    assert.ok(result!.panes.every((p) => p.size === 50));
  });

  test('does not append a session whose snapshot has not arrived yet', () => {
    const layout = { orientation: 'vertical' as const, panes: [] };
    const result = reconcilePaneLayout(layout, new Set(['a']), []);
    assert.strictEqual(result, null);
  });

  test('drops a pane whose session was closed (archived, no longer eligible)', () => {
    const layout = {
      orientation: 'horizontal' as const,
      panes: [{ sessionId: 'a', size: 50 }, { sessionId: 'b', size: 50 }],
    };
    const result = reconcilePaneLayout(layout, new Set(['a']), ['a', 'b']);
    assert.ok(result);
    assert.deepStrictEqual(result!.panes.map((p) => p.sessionId), ['a']);
    assert.strictEqual(result!.panes[0].size, 100);
  });

  test('drops a pane whose session was deleted outright', () => {
    const layout = {
      orientation: 'vertical' as const,
      panes: [{ sessionId: 'a', size: 50 }, { sessionId: 'b', size: 50 }],
    };
    // 'b' is gone from the roster entirely (not just archived) after
    // delete-session; it must not linger in the reconciled layout.
    const result = reconcilePaneLayout(layout, new Set(['a']), ['a']);
    assert.ok(result);
    assert.deepStrictEqual(result!.panes.map((p) => p.sessionId), ['a']);
  });

  test('never re-adds an archived or deleted session even if its snapshot lingers', () => {
    const layout = { orientation: 'vertical' as const, panes: [] };
    const result = reconcilePaneLayout(layout, new Set([]), ['a']);
    assert.strictEqual(result, null);
  });

  test('preserves orientation across a reconciliation', () => {
    const layout = { orientation: 'horizontal' as const, panes: [] };
    const result = reconcilePaneLayout(layout, new Set(['a']), ['a']);
    assert.strictEqual(result!.orientation, 'horizontal');
  });
});
