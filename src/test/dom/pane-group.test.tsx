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

  test('hiding a pane from its header moves focus off <body>', async () => {
    renderApp();
    hydrate(['a', 'b']);

    const closeA = screen.getByLabelText('Hide Session a from the split');
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

  test('hiding the last pane focuses the empty-state fallback, not <body>', async () => {
    renderApp();
    hydrate(['a']);

    const closeA = screen.getByLabelText('Hide Session a from the split');
    closeA.focus();
    await userEvent.click(closeA);

    screen.getByText(/no sessions in the split/i);
    assert.notStrictEqual(
      document.activeElement, document.body,
      'closing the only pane must not silently drop focus to <body>',
    );
    assert.ok(document.activeElement?.isConnected, 'focus must land on an element still in the document');
    // The fallback container itself is the focus target here (there's no
    // `[data-slot="button"]` left to prefer) — it must carry a visible
    // focus ring, or the recovery this test is about is invisible to a
    // sighted keyboard user, exactly where it's hardest won.
    assert.match(
      document.activeElement!.className, /focus-visible:ring-2/,
      'the empty-state fallback focus target must carry a focus-visible ring',
    );
  });

  test('deleting the session behind a focused pane does not drop focus to <body>', async () => {
    renderApp();
    hydrate(['a']);

    // Establishes that focus was live inside the pane the deletion is about
    // to remove — the same starting point as the header-hide tests above.
    screen.getByLabelText('Hide Session a from the split').focus();

    await userEvent.click(screen.getByText(/1 of 1 in split/i));
    await userEvent.click(await screen.findByLabelText('More actions for Session a'));
    await userEvent.click(await screen.findByLabelText('Delete session Session a'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete Session a' }));

    // `delete-session` alone doesn't touch the roster locally — only the
    // host's echo does (see pane-layout.ts's `reconcilePaneLayout` doc
    // comment) — so this simulates that echo, which is what actually drops
    // 'a' from the roster and, via App's reconcile effect one render later,
    // from the layout.
    sendFromHost({ t: 'sessions-changed', sessions: [] });

    assert.strictEqual(screen.queryByLabelText('Session: Session a'), null);
    assert.notStrictEqual(
      document.activeElement, document.body,
      'deleting the session behind a focused pane must not silently drop focus to <body>',
    );
    assert.ok(document.activeElement?.isConnected, 'focus must land on an element still in the document');
  });

  test('title-derived accessible names disambiguate when panes share a title', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [summary('a', { title: 'Untitled' }), summary('b', { title: 'Untitled' })],
      layout: layoutOf('a', 'b'),
      snapshots: [snapshot('a', { title: 'Untitled' }), snapshot('b', { title: 'Untitled' })],
      catalog: catalog(),
    });

    const closeA = screen.getByLabelText(/Hide Untitled \(a\) from the split/);
    const closeB = screen.getByLabelText(/Hide Untitled \(b\) from the split/);
    assert.notStrictEqual(
      closeA.getAttribute('aria-label'), closeB.getAttribute('aria-label'),
      'two same-titled panes must still be distinguishable to a screen reader',
    );
    screen.getByLabelText('Resize between Untitled (a) and Untitled (b)');
  });
});
