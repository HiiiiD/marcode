import * as assert from 'assert';
import { initialState, reduce } from '../../client-core/reducer';
import { wantsFor } from '../../daemon/client-wants';
import type { HostToWebview } from '../../protocol/messages';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';

const hydrate = (ids: string[]): HostToWebview => ({
  t: 'hydrate', sessions: ids.map((id) => summary(id)), snapshots: ids.map((id) => snapshot(id)), layout: layoutOf(ids),
  catalog: catalog(), unavailable: [], usage: {},
} as HostToWebview);

suite('side chat summaries in the client reducer', () => {
  const withSide = () => {
    let state = reduce(initialState, hydrate(['main']));
    state = reduce(state, { t: 'session-snapshot', session: snapshot('side', { kind: 'side', parentId: 'main' }) });
    return state;
  };

  test('a pane for a side chat is created from its snapshot even though the roster lacks it', () => {
    const state = withSide();

    assert.strictEqual(state.byId.side !== undefined, true);
    assert.strictEqual(state.sessions.some((s) => s.id === 'side'), false);
  });

  test('a side summary updates the pane and not the roster', () => {
    const state = reduce(withSide(), {
      t: 'side-summary', session: summary('side', { kind: 'side', parentId: 'main', permissionMode: 'acceptEdits' }),
    });

    assert.strictEqual(state.byId.side.summary.permissionMode, 'acceptEdits');
    assert.strictEqual(state.sessions.some((s) => s.id === 'side'), false);
  });

  test('a roster update that omits the side chat leaves its pane alone', () => {
    const state = reduce(withSide(), { t: 'sessions-changed', sessions: [summary('main')] });

    assert.strictEqual(state.byId.side !== undefined, true);
  });

  test('a side summary for an unknown pane changes nothing', () => {
    const before = reduce(initialState, hydrate(['main']));

    const after = reduce(before, { t: 'side-summary', session: summary('ghost', { kind: 'side' }) });

    assert.strictEqual(after, before);
  });

  test('only the sidebar and terminal clients are sent side summaries', () => {
    const msg: HostToWebview = { t: 'side-summary', session: summary('side', { kind: 'side' }) };

    assert.deepStrictEqual(
      (['sidebar', 'tui', 'review', 'fleet', 'history'] as const).map((k) => wantsFor(k)(msg)),
      [true, true, false, false, false],
    );
  });
});
