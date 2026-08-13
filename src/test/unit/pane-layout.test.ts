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
  test('keeps only panes whose session is in the roster and has a snapshot', () => {
    const panes = [{ sessionId: 'a', size: 50 }, { sessionId: 'b', size: 50 }];
    const result = visiblePanes(panes, new Set(['a', 'b']), new Set(['a']));
    assert.deepStrictEqual(result.map((p) => p.sessionId), ['a']);
  });

  test('keeps an archived session\'s pane — eligibility is roster membership, not archived status', () => {
    const panes = [{ sessionId: 'a', size: 100 }];
    // 'a' is archived but still in the roster (roster membership doesn't
    // encode archived/live — see reconcilePaneLayout's doc comment) and has
    // a snapshot: its pane must render.
    const result = visiblePanes(panes, new Set(['a']), new Set(['a']));
    assert.deepStrictEqual(result.map((p) => p.sessionId), ['a']);
  });

  test('drops a pane whose session snapshot has not arrived yet', () => {
    const panes = [{ sessionId: 'a', size: 100 }];
    const result = visiblePanes(panes, new Set(['a']), new Set([]));
    assert.deepStrictEqual(result, []);
  });

  test('drops a pane whose session was deleted outright (absent from the roster)', () => {
    const panes = [{ sessionId: 'a', size: 100 }, { sessionId: 'b', size: 0 }];
    // 'b' still lingers in byId (never cleaned up client-side) but is gone
    // from the roster entirely.
    const result = visiblePanes(panes, new Set(['a']), new Set(['a', 'b']));
    assert.deepStrictEqual(result.map((p) => p.sessionId), ['a']);
  });
});

suite('pane-layout reconcilePaneLayout', () => {
  test('returns layout: null when the layout already matches the roster', () => {
    const layout = { orientation: 'vertical' as const, panes: [{ sessionId: 'a', size: 100 }] };
    const result = reconcilePaneLayout(layout, new Set(['a']), ['a'], new Set(['a']));
    assert.strictEqual(result.layout, null);
  });

  test('appends a session on its first-ever snapshot arrival (freshly created)', () => {
    const layout = { orientation: 'vertical' as const, panes: [{ sessionId: 'a', size: 100 }] };
    const result = reconcilePaneLayout(layout, new Set(['a', 'b']), ['a', 'b'], new Set(['a']));
    assert.ok(result.layout);
    assert.deepStrictEqual(result.layout!.panes.map((p) => p.sessionId), ['a', 'b']);
    assert.ok(result.layout!.panes.every((p) => p.size === 50));
    assert.ok(result.knownSessionIds.has('b'), 'newly-appended session must be marked known');
  });

  test('does not append a session whose snapshot has not arrived yet', () => {
    const layout = { orientation: 'vertical' as const, panes: [] };
    const result = reconcilePaneLayout(layout, new Set(['a']), [], new Set());
    assert.strictEqual(result.layout, null);
  });

  test('drops a pane whose session was deleted outright (no longer in the roster)', () => {
    const layout = {
      orientation: 'vertical' as const,
      panes: [{ sessionId: 'a', size: 50 }, { sessionId: 'b', size: 50 }],
    };
    // 'b' is gone from the roster entirely after delete-session.
    const result = reconcilePaneLayout(layout, new Set(['a']), ['a'], new Set(['a', 'b']));
    assert.ok(result.layout);
    assert.deepStrictEqual(result.layout!.panes.map((p) => p.sessionId), ['a']);
  });

  test('preserves orientation across a reconciliation', () => {
    const layout = { orientation: 'horizontal' as const, panes: [] };
    const result = reconcilePaneLayout(layout, new Set(['a']), ['a'], new Set());
    assert.strictEqual(result.layout!.orientation, 'horizontal');
  });

  // --- Fix round 1: FINDING 2 ---
  // Unchecking a live session in the roster must not have its pane silently
  // reappear on the very next reconcile pass, even though the session is
  // still live and still has a `byId` snapshot.
  test('does not re-add a pane the user just removed for a still-live, already-known session', () => {
    // Simulates: user had 'a' and 'b' open, then unchecked 'b'. The
    // session-picker already posted a layout without 'b' (dropping it
    // client-side via local-layout); 'b' stays live, stays in byId. A prior
    // reconcile pass already marked 'b' known (it had a pane before), so
    // it must not come back just because it's still live.
    const layoutAfterUncheck = { orientation: 'vertical' as const, panes: [{ sessionId: 'a', size: 100 }] };
    const result = reconcilePaneLayout(
      layoutAfterUncheck, new Set(['a', 'b']), ['a', 'b'], new Set(['a', 'b']),
    );
    assert.strictEqual(result.layout, null, 'reconcile must not re-append the unchecked, already-known session');
  });

  // --- Fix round 1: FINDING 3 ---
  // Checking an archived session in the roster must give it a pane, and
  // that pane must survive the next reconcile pass rather than being
  // dropped again by session-state-derived eligibility.
  test('keeps a pane the user just opened for an archived session across reconcile', () => {
    // Simulates: user checked an archived session 'a' in the roster. The
    // picker posted set-visible + a layout containing 'a'; its (disk-served)
    // snapshot has landed in byId. Archived sessions are still counted as
    // "in the roster" (SessionManager never removes an archived session
    // from the roster — only delete-session does), so 'a' stays eligible.
    const layoutAfterCheckingArchived = { orientation: 'vertical' as const, panes: [{ sessionId: 'a', size: 100 }] };
    const result = reconcilePaneLayout(
      layoutAfterCheckingArchived, new Set(['a']), ['a'], new Set(['a']),
    );
    assert.strictEqual(result.layout, null, 'an explicitly opened archived session\'s pane must not be dropped');
  });

  test('never drops or blocks re-adding an archived session that was never removed from the roster', () => {
    // reconcile only removes sessions absent from the roster entirely
    // (deleted) — archived status by itself must never cause a drop.
    const layout = { orientation: 'vertical' as const, panes: [{ sessionId: 'a', size: 100 }] };
    const result = reconcilePaneLayout(layout, new Set(['a']), ['a'], new Set(['a']));
    assert.strictEqual(result.layout, null);
  });
});
