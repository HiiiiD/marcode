import * as assert from 'assert';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, sendFromHost } from './harness';
import { resizeTo } from './setup';

/** Two sessions in the roster, only 'a' currently open in a pane. */
function hydrateAOpen() {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a'), summary('b')],
    layout: layoutOf('a'),
    snapshots: [snapshot('a')],
    catalog: catalog(),
  });
}

suite('SessionPicker', () => {
  test('the roster trigger says what checking a row does', () => {
    renderApp();
    hydrateAOpen();

    screen.getByRole('button', { name: /1 of 2 in split/i });
  });

  test('checking a closed session posts set-layout and set-visible for both', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByText(/1 of 2 in split/i));
    await userEvent.click(await screen.findByText('Session b'));

    const layouts = posted().filter((m) => m.t === 'set-layout');
    assert.deepStrictEqual(layouts.at(-1), {
      t: 'set-layout',
      layout: { orientation: 'vertical', panes: [{ sessionId: 'a', size: 50 }, { sessionId: 'b', size: 50 }] },
    });

    const visible = posted().filter((m) => m.t === 'set-visible');
    assert.deepStrictEqual(visible.at(-1), { t: 'set-visible', sessionIds: ['a', 'b'] });
  });

  test('each session appears exactly once in the roster', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByText(/1 of 2 in split/i));
    assert.strictEqual(
      (await screen.findAllByText('Session b')).length, 1,
      'the roster listed every session twice: once to toggle, once to delete',
    );
  });

  test('archive is an explicit, labelled action in the roster row', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByText(/1 of 2 in split/i));
    await userEvent.click(await screen.findByLabelText('More actions for Session b'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive Session b' }));

    assert.deepStrictEqual(posted().at(-1), { t: 'close-session', id: 'b' });
  });

  test('delete is behind a per-row confirm and only fires on the second step', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByText(/1 of 2 in split/i));
    await userEvent.click(await screen.findByLabelText('More actions for Session b'));
    await userEvent.click(await screen.findByLabelText('Delete session Session b'));

    assert.ok(
      !posted().some((m) => m.t === 'delete-session'),
      'opening the confirm must not delete anything',
    );

    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete Session b' }));
    assert.deepStrictEqual(posted().at(-1), { t: 'delete-session', id: 'b' });
  });

  test('the confirm offers a way out', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByText(/1 of 2 in split/i));
    await userEvent.click(await screen.findByLabelText('More actions for Session b'));
    await userEvent.click(await screen.findByLabelText('Delete session Session b'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Keep it' }));

    assert.ok(!posted().some((m) => m.t === 'delete-session'));
    assert.strictEqual(
      screen.queryByRole('menuitem', { name: /Delete Session/ }), null,
      'activating "Keep it" must close the submenu, not just decline to delete',
    );
  });

  test('opening the actions submenu by keyboard lands on the safe item, not delete', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByText(/1 of 2 in split/i));
    // a checkbox, a actions trigger, b checkbox, b actions trigger.
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
    assert.strictEqual(
      document.activeElement?.getAttribute('aria-label'), 'More actions for Session b',
      'roving focus must land on the submenu trigger without a mouse',
    );

    await userEvent.keyboard('{ArrowRight}');
    const archiveItem = await screen.findByRole('menuitem', { name: 'Archive Session b' });
    assert.strictEqual(
      document.activeElement, archiveItem,
      'ArrowRight must focus "Archive" first — it is the first, non-nested item in the actions menu',
    );

    await userEvent.keyboard('{ArrowDown}');
    const deleteTrigger = await screen.findByLabelText('Delete session Session b');
    assert.strictEqual(
      document.activeElement, deleteTrigger,
      'the next roving-focus stop is the nested delete trigger, not a menu item that deletes',
    );

    await userEvent.keyboard('{ArrowRight}');
    const keepIt = await screen.findByRole('menuitem', { name: 'Keep it' });
    assert.strictEqual(
      document.activeElement, keepIt,
      'ArrowRight must focus "Keep it" first — Delete must never be the default '
        + 'focus a keyboard user lands on when opening the delete confirm, even one level '
        + 'deeper than before',
    );

    // Enter here must be a no-op for deletion: it activates the highlighted
    // "Keep it" item, not "Delete".
    await userEvent.keyboard('{Enter}');
    assert.ok(
      !posted().some((m) => m.t === 'delete-session'),
      'ArrowRight then Enter is the natural "open and activate" gesture and must not delete',
    );
  });

  test('reaching delete by keyboard requires a further deliberate step', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByText(/1 of 2 in split/i));
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
    await userEvent.keyboard('{ArrowRight}');
    await screen.findByRole('menuitem', { name: 'Archive Session b' });
    await userEvent.keyboard('{ArrowDown}{ArrowRight}');
    await screen.findByRole('menuitem', { name: 'Keep it' });

    await userEvent.keyboard('{ArrowDown}');
    const deleteItem = await screen.findByRole('menuitem', { name: 'Delete Session b' });
    assert.strictEqual(document.activeElement, deleteItem);

    await userEvent.keyboard('{Enter}');
    assert.deepStrictEqual(posted().at(-1), { t: 'delete-session', id: 'b' });
  });

  test('archived sessions are grouped, not marked with a word', async () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [summary('a'), summary('b', { archived: true })],
      layout: layoutOf('a'),
      snapshots: [snapshot('a')],
      catalog: catalog(),
    });

    await userEvent.click(screen.getByText(/1 of 2 in split/i));
    screen.getByText('Archived (1)');
  });

  test('toggling visibility still posts set-layout and set-visible', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByText(/1 of 2 in split/i));
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Session b/ }));

    assert.deepStrictEqual(posted().filter((m) => m.t === 'set-visible').at(-1), {
      t: 'set-visible', sessionIds: ['a', 'b'],
    });
  });

  test('the orientation toggle posts the flipped layout', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByLabelText(/split direction/i));

    const layouts = posted().filter((m) => m.t === 'set-layout');
    assert.strictEqual(layouts.at(-1)!.layout.orientation, 'horizontal');
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
      layout: { orientation: 'horizontal', panes: [{ sessionId: 'a', size: 50 }, { sessionId: 'b', size: 50 }] },
      snapshots: [snapshot('a'), snapshot('b')],
      catalog: catalog(),
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

  test('the empty state offers the way out', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate', sessions: [], layout: { orientation: 'vertical', panes: [] },
      snapshots: [], catalog: catalog(),
    });

    const emptyState = screen.getByText(/no sessions yet/i).closest('div')!;
    // The roster's own "New" trigger also matches this accessible name, so
    // this is scoped to the empty-state panel rather than screen-wide —
    // this test is about the empty state offering its own way out, not
    // about there being exactly one "New session" control on the page.
    within(emptyState).getByRole('button', { name: 'New session' });
  });
});
