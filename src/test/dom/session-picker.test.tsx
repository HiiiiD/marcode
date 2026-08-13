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

  test('the delete item posts delete-session', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByText('Sessions (1/2)'));
    await userEvent.click(await screen.findByLabelText('Delete session Session b'));

    assert.deepStrictEqual(posted().at(-1), { t: 'delete-session', id: 'b' });
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

  test('New posts create-session with the first catalog provider', async () => {
    renderApp();
    hydrateAOpen();

    await userEvent.click(screen.getByText('+ New'));

    assert.deepStrictEqual(posted().at(-1), { t: 'create-session', providerId: 'fake', cwd: '' });
  });
});
