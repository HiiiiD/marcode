import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

    screen.getByLabelText('Resize between Session a and Session b');
    screen.getByLabelText('Resize between Session b and Session c');
    assert.strictEqual(screen.queryByLabelText(/Resize between panes/), null);
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

  test('closing a pane from its header moves focus off <body>', async () => {
    renderApp();
    hydrate(['a', 'b']);

    const closeA = screen.getByLabelText('Close session Session a');
    closeA.focus();
    await userEvent.click(closeA);

    // The remaining pane's own state doesn't need a host round-trip here:
    // `set-layout` is applied optimistically (see store.tsx's `local-layout`
    // comment), so the pane is already gone by the time this assertion runs.
    assert.strictEqual(screen.queryByLabelText('Session: Session a'), null);
    assert.notStrictEqual(
      document.activeElement, document.body,
      'closing the focused pane must not silently drop focus to <body>',
    );
    assert.ok(document.activeElement?.isConnected, 'focus must land on an element still in the document');
  });

  test('closing the last pane focuses the empty-state fallback, not <body>', async () => {
    renderApp();
    hydrate(['a']);

    const closeA = screen.getByLabelText('Close session Session a');
    closeA.focus();
    await userEvent.click(closeA);

    screen.getByText(/no sessions in the split/i);
    assert.notStrictEqual(
      document.activeElement, document.body,
      'closing the only pane must not silently drop focus to <body>',
    );
    assert.ok(document.activeElement?.isConnected, 'focus must land on an element still in the document');
  });
});
