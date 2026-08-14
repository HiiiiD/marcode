import * as assert from 'assert';
import {
  accessibleTitles, evenlySizedPanes, reconcilePaneLayout, rosterSessionIds, visiblePanes,
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

  test('renders a repeated sessionId once — a duplicated key renders the same session twice', () => {
    const panes = [
      { sessionId: 'a', size: 40 }, { sessionId: 'b', size: 20 }, { sessionId: 'a', size: 40 },
    ];
    const result = visiblePanes(panes, new Set(['a', 'b']), new Set(['a', 'b']));
    assert.deepStrictEqual(result.map((p) => p.sessionId), ['a', 'b']);
    assert.strictEqual(result[0].size, 40, 'first entry wins, keeping position and size');
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

  test('repairs a persisted layout that names the same session twice', () => {
    const layout = {
      orientation: 'vertical' as const,
      panes: [{ sessionId: 'a', size: 50 }, { sessionId: 'a', size: 50 }],
    };
    const result = reconcilePaneLayout(layout, new Set(['a']), ['a'], new Set(['a']));
    assert.ok(result.layout, 'a duplicated layout must be rewritten, not left as-is');
    assert.deepStrictEqual(result.layout!.panes.map((p) => p.sessionId), ['a']);
    assert.strictEqual(result.layout!.panes[0].size, 100);
  });

  // Fix round 1's "Finding 3" cases here were removed in fix round 2: they
  // were byte-identical to `returns layout: null when the layout already
  // matches the roster` above (and to each other) — reconcilePaneLayout has
  // no notion of "archived" at all, only roster membership, so nothing in
  // them actually exercised archived-specific behavior despite what their
  // names claimed. Finding 3's real bug lived in how CALLERS built the
  // roster set (pane-group.tsx / main.tsx used to filter out archived
  // sessions before ever calling into this module) — that's now pinned
  // directly against `rosterSessionIds` below, which is where the decision
  // actually lives.
});

suite('pane-layout rosterSessionIds', () => {
  // Fix round 2: pins the actual caller-side bug behind Finding 3. Before
  // the fix, `pane-group.tsx` and `main.tsx` each independently computed
  // eligibility as `state.sessions.filter(s => !s.archived).map(s => s.id)`
  // — an archived session's id was never even offered to `visiblePanes` /
  // `reconcilePaneLayout`, so checking it in the roster picker could never
  // give it a pane. `rosterSessionIds` is the single, tested place that
  // decision now lives, and it must include archived sessions.
  test('includes archived sessions — eligibility is roster membership, not liveness', () => {
    const ids = rosterSessionIds([
      { id: 'a', archived: false },
      { id: 'b', archived: true },
    ]);
    assert.ok(ids.has('a'));
    assert.ok(ids.has('b'), 'an archived session must still be eligible for a pane');
  });

  test('reflects exactly the roster, not a subset of it', () => {
    const ids = rosterSessionIds([{ id: 'x', archived: false }]);
    assert.deepStrictEqual([...ids], ['x']);
  });

  test('an empty roster yields an empty set', () => {
    assert.deepStrictEqual([...rosterSessionIds([])], []);
  });
});

suite('pane-layout accessibleTitles', () => {
  test('a unique title passes through unchanged', () => {
    const names = accessibleTitles([{ id: 'a', title: 'Session a' }, { id: 'b', title: 'Session b' }]);
    assert.strictEqual(names.get('a'), 'Session a');
    assert.strictEqual(names.get('b'), 'Session b');
  });

  test('a shared title gets the id appended, for every session that shares it', () => {
    const names = accessibleTitles([
      { id: 'a', title: 'Untitled' },
      { id: 'b', title: 'Untitled' },
      { id: 'c', title: 'Session c' },
    ]);
    assert.strictEqual(names.get('a'), 'Untitled (a)');
    assert.strictEqual(names.get('b'), 'Untitled (b)');
    assert.strictEqual(names.get('c'), 'Session c', 'a title with no collision must stay plain');
    assert.notStrictEqual(names.get('a'), names.get('b'));
  });

  test('an empty list yields an empty map', () => {
    assert.deepStrictEqual([...accessibleTitles([])], []);
  });
});
