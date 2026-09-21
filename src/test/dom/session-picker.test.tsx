import * as assert from 'assert';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog, layoutOf, singlePaneLayout, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, sendFromHost } from './harness';
import { resizeTo } from './setup';

/** Two sessions in the roster, only 'a' currently open in a pane. */
function hydrateAOpen() {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a'), summary('b')],
    layout: layoutOf(['a']),
    snapshots: [snapshot('a')],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

suite('SessionPicker', () => {
  test('the trigger opens the history tab instead of a roster menu', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByRole('button', { name: /Browse session history/ }));

    assert.strictEqual(posted().some((m) => m.t === 'open-history'), true);
    assert.strictEqual(screen.queryByRole('menu') === null, true);
  });

  test('the history button carries the count of sessions that need the user', () => {
    renderApp();
    hydrateAOpen();
    sendFromHost({ t: 'session-status', id: 'a', status: 'awaiting-approval' });

    const button = screen.getByRole('button', { name: /Browse session history/ });
    assert.strictEqual((button.textContent ?? '').includes('1 needs you'), true);
  });

  test('the working-trees control appears once a sweep names a tree', () => {
    renderApp();
    hydrateAOpen();
    sendFromHost({
      t: 'stale-trees',
      trees: [{ path: '/repo/trees/old-thing', branch: 'old-thing', clean: true }],
    });

    screen.getByRole('button', { name: /^Working trees \(1\)/ });
  });

  test('the orientation toggle posts the flipped layout', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByLabelText(/split direction/i));

    const layouts = posted().filter((m) => m.t === 'set-layout');
    const root = layouts.at(-1)!.layout.root;
    assert.strictEqual(root.kind === 'split' ? root.orientation : undefined, 'horizontal');
  });

  test('the orientation toggle announces its current state', () => {
    renderApp();
    hydrateAOpen();

    const toggle = screen.getByLabelText(/split direction/i);
    assert.strictEqual(toggle.getAttribute('aria-pressed'), 'false');
  });

  test('icon buttons use icon size variants rather than hand-written boxes', () => {
    renderApp();
    hydrateAOpen();

    const toggle = screen.getByLabelText(/split direction/i);
    assert.ok(
      // Also covers `h-auto`/`w-auto`, not just a hand-written pixel size —
      // the same discipline tool-card.tsx and transcript.tsx's Buttons are
      // held to (see composer.test.tsx's matching guard).
      !/\b[hw]-(?:\d|auto)/.test(toggle.className),
      'use size="icon-sm"; twMerge does not strip size-8 when h-7 w-7 is added',
    );
  });

  test('a narrow panel disables the orientation toggle, explains why, and stacks the panes', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [summary('a'), summary('b')],
      layout: layoutOf(['a', 'b'], 'horizontal'),
      snapshots: [snapshot('a'), snapshot('b')],
      catalog: catalog(),
      unavailable: [],
      usage: {},
    });

    // App owns the single ResizeObserver both SessionPicker and PaneGroup
    // read `narrow` from — driving it here exercises both at once, and is
    // the only way to prove they agree rather than each observing their
    // own root and drifting apart near the threshold.
    resizeTo(400);

    const toggle = screen.getByLabelText(/split direction/i);
    assert.strictEqual((toggle as HTMLButtonElement).disabled, true);
    // A `title` on a disabled control is unreliably announced and
    // unreachable without a pointer — the reason lives in `aria-describedby`
    // text instead (see task 12).
    const describedBy = toggle.getAttribute('aria-describedby');
    assert.ok(describedBy, 'the disabled toggle must point at its reason via aria-describedby');
    assert.match(
      document.getElementById(describedBy!)?.textContent ?? '',
      /too narrow to split side by side/i,
    );

    assert.strictEqual(
      (screen.getByLabelText('Open agent sessions') as HTMLElement).style.flexDirection, 'column',
      'the layout says horizontal, but a narrow panel must still stack the panes',
    );
  });

  test('a single open pane disables the orientation toggle and explains why', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [summary('a'), summary('b')],
      layout: singlePaneLayout('a'), // a bare leaf root: only 'a' is open, nothing to reorient
      snapshots: [snapshot('a')],
      catalog: catalog(),
      unavailable: [],
      usage: {},
    });

    const toggle = screen.getByLabelText(/split direction/i);
    assert.strictEqual((toggle as HTMLButtonElement).disabled, true);
    const describedBy = toggle.getAttribute('aria-describedby');
    assert.ok(describedBy, 'the disabled toggle must point at its reason via aria-describedby');
    assert.match(
      document.getElementById(describedBy!)?.textContent ?? '',
      /one pane/i,
    );
  });

  test('the picker asks the host to open the review tab', async () => {
    renderApp();
    sendFromHost({
      t: 'hydrate', sessions: [], layout: layoutOf([]),
      snapshots: [], catalog: catalog(), unavailable: [], usage: {},
    });

    await userEvent.click(screen.getByRole('button', { name: /Review fleet changes/ }));

    assert.strictEqual(posted().some((m) => m.t === 'open-review'), true);
  });

  test('the picker asks the host to open the fleet view', async () => {
    renderApp();
    sendFromHost({
      t: 'hydrate', sessions: [], layout: layoutOf([]),
      snapshots: [], catalog: catalog(), unavailable: [], usage: {},
    });

    await userEvent.click(screen.getByRole('button', { name: /Open the fleet view/ }));

    assert.strictEqual(posted().some((m) => m.t === 'open-fleet'), true);
  });

  test('the empty state offers the way out', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate', sessions: [], layout: layoutOf([]),
      snapshots: [], catalog: catalog(), unavailable: [], usage: {},
    });

    const emptyState = screen.getByText(/no sessions yet/i).closest('div')!;
    // The roster's own "New" trigger also matches this accessible name, so
    // this is scoped to the empty-state panel rather than screen-wide —
    // this test is about the empty state offering its own way out, not
    // about there being exactly one "New session" control on the page.
    within(emptyState).getByRole('button', { name: 'New session' });
  });
});
