import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, sendFromHost } from './harness';

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
  test('the trigger shows open-over-total', () => {
    renderApp();
    hydrateAOpen();

    screen.getByText('Sessions (1/2)');
  });

  test('checking a closed session posts set-layout and set-visible for both', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByText('Sessions (1/2)'));
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

    await userEvent.click(screen.getByText('Sessions (1/2)'));
    assert.strictEqual(
      (await screen.findAllByText('Session b')).length, 1,
      'the roster listed every session twice: once to toggle, once to delete',
    );
  });

  test('delete is behind a per-row confirm and only fires on the second step', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByText('Sessions (1/2)'));
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

    await userEvent.click(screen.getByText('Sessions (1/2)'));
    await userEvent.click(await screen.findByLabelText('Delete session Session b'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Keep it' }));

    assert.ok(!posted().some((m) => m.t === 'delete-session'));
  });

  test('arrow keys alone reach and open the delete submenu', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByText('Sessions (1/2)'));
    // a checkbox, a delete trigger, b checkbox, b delete trigger.
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
    assert.strictEqual(
      document.activeElement?.getAttribute('aria-label'), 'Delete session Session b',
      'roving focus must land on the submenu trigger without a mouse',
    );

    await userEvent.keyboard('{ArrowRight}');
    await userEvent.keyboard('{Enter}');

    assert.deepStrictEqual(posted().at(-1), { t: 'delete-session', id: 'b' });
  });

  test('toggling visibility still posts set-layout and set-visible', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByText('Sessions (1/2)'));
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Session b/ }));

    assert.deepStrictEqual(posted().filter((m) => m.t === 'set-visible').at(-1), {
      t: 'set-visible', sessionIds: ['a', 'b'],
    });
  });

  test('the orientation toggle posts the flipped layout', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByLabelText('Toggle split orientation'));

    const layouts = posted().filter((m) => m.t === 'set-layout');
    assert.strictEqual(layouts.at(-1)!.layout.orientation, 'horizontal');
  });

  test('icon buttons use icon size variants rather than hand-written boxes', () => {
    renderApp();
    hydrateAOpen();

    const toggle = screen.getByLabelText('Toggle split orientation');
    assert.ok(
      !/\b[hw]-\d/.test(toggle.className),
      'use size="icon-sm"; twMerge does not strip size-8 when h-7 w-7 is added',
    );
  });
});
