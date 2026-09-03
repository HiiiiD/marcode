import * as assert from 'assert';
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, renderWithStore, sendFromHost } from './harness';
import { PaneGroup } from '@/components/pane-group';
import type { TranscriptItem } from '../../protocol/messages';

function hydrate(paneIds: string[], rosterIds = paneIds) {
  sendFromHost({
    t: 'hydrate',
    sessions: rosterIds.map((id) => summary(id)),
    layout: layoutOf(...paneIds),
    snapshots: rosterIds.map((id) => snapshot(id)),
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

suite('PaneGroup', () => {
  test('the empty state names the providers that are unavailable, and why', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [], layout: layoutOf(), snapshots: [],
      catalog: [],
      unavailable: [{ id: 'claude', displayName: 'Claude', reason: 'Claude Code CLI not found.' }],
      probing: false,
      usage: {},
    });

    // Without this the panel offers a dead `+ New` and no account of itself.
    assert.ok(screen.getByText(/no agent provider is available/i));
    assert.ok(screen.getByText(/Claude Code CLI not found\./));
  });

  test('an empty catalog nobody has answered for yet is a wait, not a verdict', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [], layout: layoutOf(), snapshots: [],
      catalog: [], unavailable: [], probing: true, usage: {},
    });

    // The second a CLI handshake takes must not read as "this install is
    // broken" — that accusation is only true once the probe has settled.
    assert.ok(screen.getByText(/checking for agent backends/i));
    assert.strictEqual(screen.queryByText(/no agent provider is/i) === null, true);
  });

  test('a settled empty catalog with no reasons says nothing is enabled, and offers the setting', async () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [], layout: layoutOf(), snapshots: [],
      catalog: [], unavailable: [], probing: false, usage: {},
    });

    // Nothing was asked, so there is no reason to report and no point
    // re-asking: the remedy is the setting that enables a provider.
    assert.ok(screen.getByText(/no agent provider is enabled/i));
    assert.strictEqual(screen.queryByRole('button', { name: /check again/i }) === null, true);

    await userEvent.click(screen.getByRole('button', { name: /open settings/i }));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'open-settings', section: 'marcode.enabledProviders marcode.providerInstances',
    });
  });

  test('the failed-probe empty state can ask the backends again', async () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [], layout: layoutOf(), snapshots: [],
      catalog: [],
      unavailable: [{ id: 'claude', displayName: 'Claude', reason: 'Claude Code CLI not found.' }],
      probing: false,
      usage: {},
    });

    await userEvent.click(screen.getByRole('button', { name: /check again/i }));

    // Re-probing IS the availability check, so this is the whole remedy for
    // an install repaired in a terminal while the panel sat open.
    assert.deepStrictEqual(posted().at(-1), { t: 'refresh-catalog' });
  });

  test('a not-signed-in provider offers a login action in the empty state', async () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [], layout: layoutOf(), snapshots: [],
      catalog: [],
      unavailable: [{ id: 'claude', displayName: 'Claude', reason: 'Not signed in to Claude. Run `claude auth login`.' }],
      probing: false,
      usage: {},
    });

    await userEvent.click(screen.getByRole('button', { name: /log in/i }));

    assert.deepStrictEqual(posted().at(-1), { t: 'login-provider', providerId: 'claude' });
  });

  test('an unavailable provider with no login-shaped reason offers no login action', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [], layout: layoutOf(), snapshots: [],
      catalog: [],
      unavailable: [{ id: 'claude', displayName: 'Claude', reason: 'Claude Code CLI not found.' }],
      probing: false,
      usage: {},
    });

    assert.strictEqual(screen.queryByRole('button', { name: /log in/i }) === null, true);
  });

  test('an unavailable provider with loginKind "none" offers no login action even with sign-in text', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [], layout: layoutOf(), snapshots: [],
      catalog: [],
      unavailable: [{
        id: 'claude-work', displayName: 'Claude (work)',
        reason: 'Not signed in to Claude. Run `claude auth login`.',
        loginKind: 'none',
      }],
      probing: false,
      usage: {},
    });
    assert.strictEqual(screen.queryByRole('button', { name: /log in/i }) === null, true);
  });

  test('an unavailable provider with loginKind "oauth" offers no login action for an unrelated reason', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [], layout: layoutOf(), snapshots: [],
      catalog: [],
      unavailable: [{
        id: 'codex-work', displayName: 'Codex (work)', reason: 'connection refused', loginKind: 'oauth',
      }],
      probing: false,
      usage: {},
    });
    assert.strictEqual(screen.queryByRole('button', { name: /log in/i }) === null, true);
  });

  test('an unavailable provider with loginKind "oauth" offers a login action for a sign-in-shaped reason', async () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [], layout: layoutOf(), snapshots: [],
      catalog: [],
      unavailable: [{
        id: 'codex-work', displayName: 'Codex (work)',
        reason: 'Not signed in to Codex. Run `codex login`.', loginKind: 'oauth',
      }],
      probing: false,
      usage: {},
    });
    await userEvent.click(screen.getByRole('button', { name: /log in/i }));
    assert.deepStrictEqual(posted().at(-1), { t: 'login-provider', providerId: 'codex-work' });
  });

  test('the empty state stays a plain invitation while the providers still work', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [], layout: layoutOf(), snapshots: [],
      catalog: catalog(), unavailable: [], usage: {},
    });

    assert.ok(screen.getByText(/no sessions yet/i));
    assert.strictEqual(screen.queryByText(/no agent provider is available/i) === null, true);
  });

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
      unavailable: [],
      usage: {},
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

  test('the focused pane is visually distinguished', () => {
    renderApp();
    hydrate(['a', 'b']);

    // `getAllByRole('region')` doesn't work here: react-resizable-panels'
    // Panel renders a plain `div` (see resizable.tsx) with no implicit or
    // explicit ARIA role, so there is nothing to query by role. Panes are
    // reliably identified by the `aria-label={'Session: ' + title}` every
    // other test in this file already relies on.
    //
    // A real `.focus()` call, not `userEvent.click`: react-resizable-panels
    // installs a document-level capturing `pointerdown` listener that hit-
    // tests the click against every registered resize-handle's
    // `getBoundingClientRect()` to start a drag. jsdom has no layout engine,
    // so every rect collapses to (0,0,0,0) and the pointer's own (0,0)
    // coordinates spuriously "hit" the handle, and that listener calls
    // `preventDefault()` on the `pointerdown` — which per spec suppresses
    // the compatibility `mousedown` userEvent's click relies on to focus the
    // target. This is the same root cause behind the harness's known
    // "Select can't open with two ResizablePanels" limitation. Driving focus
    // directly sidesteps the resizable-panels hit-testing entirely and still
    // exercises exactly what's under test: the pane's `onFocusCapture`.
    const [messageA] = screen.getAllByLabelText('Message', { selector: '[data-slot="input-group-textarea"]' });
    act(() => { messageA.focus(); });

    const panels = [
      screen.getByLabelText('Session: Session a'),
      screen.getByLabelText('Session: Session b'),
    ];
    const active = panels.filter((p) => p.getAttribute('data-active') === 'true');
    assert.strictEqual(active.length, 1, 'exactly one pane is active at a time');
  });

  test('title-derived accessible names disambiguate when panes share a title', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [summary('a', { title: 'Untitled' }), summary('b', { title: 'Untitled' })],
      layout: layoutOf('a', 'b'),
      snapshots: [snapshot('a', { title: 'Untitled' }), snapshot('b', { title: 'Untitled' })],
      catalog: catalog(),
      unavailable: [],
      usage: {},
    });

    const closeA = screen.getByLabelText(/Hide Untitled \(a\) from the split/);
    const closeB = screen.getByLabelText(/Hide Untitled \(b\) from the split/);
    assert.notStrictEqual(
      closeA.getAttribute('aria-label'), closeB.getAttribute('aria-label'),
      'two same-titled panes must still be distinguishable to a screen reader',
    );
    screen.getByLabelText('Resize between Untitled (a) and Untitled (b)');

    // The pane region itself is the third title-derived accessible name
    // `accessibleTitles` exists for — a screen-reader user navigates the
    // split by these region names, so they must disambiguate too, not just
    // the close button and the resize handle either side of it.
    const panelA = screen.getByLabelText('Session: Untitled (a)');
    const panelB = screen.getByLabelText('Session: Untitled (b)');
    assert.notStrictEqual(
      panelA.getAttribute('aria-label'), panelB.getAttribute('aria-label'),
      'two same-titled panes must still be distinguishable by their region name',
    );
  });

  test('opening a subagent posts open-fleet-subagent instead of drilling the pane in place', async () => {
    renderApp();
    // Over the SUBAGENT_CHILD_WINDOW so the card's "Open full transcript"
    // affordance actually renders — it only appears once the card's own
    // window is truncating children.
    const children: TranscriptItem[] = Array.from({ length: 11 }, (_, i) => ({
      id: `c${i}`, ts: i + 1, role: 'tool', toolId: `c${i}`,
      tool: { kind: 'other', label: `Tool${i}`, raw: {} }, state: 'ok',
    }));
    const subagentItem: TranscriptItem = {
      id: 't1', ts: 1000, role: 'tool', toolId: 'task1',
      tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent: 'Explore' },
      state: 'ok', children,
    };
    sendFromHost({
      t: 'hydrate',
      sessions: [summary('a')],
      layout: layoutOf('a'),
      snapshots: [snapshot('a', { items: [subagentItem] })],
      catalog: catalog(),
      unavailable: [],
      usage: {},
    });

    await userEvent.click(screen.getByRole('button', { name: /explore/i }));
    fireEvent.click(screen.getByRole('button', { name: /open full transcript/i }));

    // The pane itself is untouched — no breadcrumb, composer still present —
    // and the request went to the host instead. Counted by tag, not just
    // role: the header's own inline session-name field is a native `<input>`,
    // which carries the same implicit `textbox` role as the composer's
    // `<textarea>`, so a plain role count would pass even if the composer
    // itself had vanished.
    assert.strictEqual(screen.queryByRole('button', { name: /back to/i }) === null, true);
    const textareas = screen.queryAllByRole('textbox').filter((el) => el.tagName === 'TEXTAREA');
    assert.strictEqual(textareas.length, 1);
    const messages = posted().filter((m) => m.t === 'open-fleet-subagent');
    assert.deepStrictEqual(messages, [{ t: 'open-fleet-subagent', sessionId: 'a', itemId: 't1' }]);
  });

  test('a layout-changed echo reveals a pane for a session already known but hidden', () => {
    // Reproduces the exact shape `focus-session` needs to fix: a session the
    // sidebar has already seen (so `reconcilePaneLayout`'s `knownSessionIds`
    // already contains it — see its doc comment) and then hidden/closed.
    // `reconcilePaneLayout` will never auto-append a known session again, so
    // only an explicit layout change from the host — this fix's
    // `layout-changed` message — can bring its pane back.
    renderApp();
    hydrate(['a', 'b']);
    screen.getByLabelText('Session: Session a');
    screen.getByLabelText('Session: Session b');

    // The host echoes a layout that dropped 'b' (e.g. the user closed its
    // pane) — both sessions are already "known" by this point, so this does
    // not itself trigger the reconcile effect to bring 'b' back.
    sendFromHost({ t: 'layout-changed', layout: layoutOf('a') });
    screen.getByLabelText('Session: Session a');
    assert.strictEqual(screen.queryByLabelText('Session: Session b') === null, true);

    // The fix under test: SessionManager.setLayout()'s echo — what
    // FleetPanel's focus-session handler now triggers — brings 'b' back.
    sendFromHost({ t: 'layout-changed', layout: layoutOf('a', 'b') });
    screen.getByLabelText('Session: Session a');
    screen.getByLabelText('Session: Session b');
  });
});
