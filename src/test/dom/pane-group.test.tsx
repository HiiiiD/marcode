import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { renderApp, renderWithStore, sendFromHost } from './harness';
import { PaneGroup } from '@/components/pane-group';

function hydrate(paneIds: string[], rosterIds = paneIds) {
  sendFromHost({
    t: 'hydrate',
    sessions: rosterIds.map((id) => summary(id)),
    layout: layoutOf(...paneIds),
    snapshots: rosterIds.map((id) => snapshot(id)),
    catalog: catalog(),
  });
}

suite('PaneGroup', () => {
  test('renders one labelled panel per layout entry', () => {
    renderApp();
    hydrate(['a', 'b', 'c']);

    screen.getByLabelText('Open agent sessions');
    for (const id of ['a', 'b', 'c']) {
      screen.getByLabelText(`Session: Session ${id}`);
    }
  });

  test('renders a resize handle between panes but not before the first', () => {
    renderApp();
    hydrate(['a', 'b', 'c']);

    screen.getByLabelText('Resize between panes 1 and 2');
    screen.getByLabelText('Resize between panes 2 and 3');
    assert.strictEqual(screen.queryByLabelText('Resize between panes 0 and 1'), null);
  });

  test('a pane whose session left the roster is not rendered', () => {
    renderApp();
    // 'b' has a pane in the layout but is absent from sessions and snapshots.
    hydrate(['a', 'b'], ['a']);

    screen.getByLabelText('Session: Session a');
    assert.strictEqual(screen.queryByLabelText('Session: Session b'), null);
  });

  test('a pane whose session is gone from the roster but whose snapshot lingers is not rendered', () => {
    // Isolates the roster-membership half of visiblePanes' `&&` from the
    // snapshot-arrival half: 'b' has a pane in the layout AND a snapshot in
    // byId, but is absent from the roster — the stale-pane-after-
    // delete-session scenario described at pane-group.tsx's comment on
    // `roster`/`snapshotArrived`. The previous test leaves 'b' out of both
    // roster and snapshots at once, so a regression that dropped either
    // condition from visiblePanes' `&&` would still pass it; this test would
    // catch that.
    //
    // Mounted directly with renderWithStore(<PaneGroup narrow={false} />) rather than
    // renderApp(): App's reconcile effect would see 'b''s pane pointing at a
    // session outside the roster, drop it, and post set-layout before this
    // test could observe visiblePanes ever having considered it. PaneGroup
    // has no such effect, so the hydrated state — including the
    // roster/snapshot mismatch — survives intact.
    renderWithStore(<PaneGroup narrow={false} />);
    sendFromHost({
      t: 'hydrate',
      sessions: [summary('a')],
      layout: layoutOf('a', 'b'),
      snapshots: [snapshot('a'), snapshot('b')],
      catalog: catalog(),
    });

    screen.getByLabelText('Session: Session a');
    assert.strictEqual(screen.queryByLabelText('Session: Session b'), null);
  });

  test('each pane carries its own composer', () => {
    renderApp();
    hydrate(['a', 'b']);

    assert.strictEqual(screen.getAllByLabelText('Message').length, 2);
  });
});
