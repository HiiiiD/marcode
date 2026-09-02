import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, sendFromHost } from './harness';

/** One session, named 'old-name', open in the only pane. */
function hydrateNamed() {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a', { name: 'old-name' })],
    layout: layoutOf('a'),
    snapshots: [snapshot('a', { name: 'old-name' })],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

suite('rename session', () => {
  test('opening the rename dialog and submitting a new name posts rename-session', async () => {
    renderApp();
    hydrateNamed();

    await userEvent.click(screen.getByText(/1 of 1 in split/i));
    await userEvent.click(await screen.findByLabelText('More actions for old-name'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));

    const input = await screen.findByLabelText('New name');
    await userEvent.clear(input);
    await userEvent.type(input, 'new-name');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    assert.deepStrictEqual(
      posted().filter((m) => m.t === 'rename-session').at(-1),
      { t: 'rename-session', id: 'a', name: 'new-name' },
    );
  });

  test('the input opens pre-filled with the current name', async () => {
    renderApp();
    hydrateNamed();

    await userEvent.click(screen.getByText(/1 of 1 in split/i));
    await userEvent.click(await screen.findByLabelText('More actions for old-name'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));

    const input = await screen.findByLabelText('New name') as HTMLInputElement;
    assert.strictEqual(input.value, 'old-name');
  });

  test('an empty name cannot be saved', async () => {
    renderApp();
    hydrateNamed();

    await userEvent.click(screen.getByText(/1 of 1 in split/i));
    await userEvent.click(await screen.findByLabelText('More actions for old-name'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));

    const input = await screen.findByLabelText('New name');
    await userEvent.clear(input);

    assert.strictEqual(
      screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled'), true,
    );
  });

  test('cancelling does not post a rename', async () => {
    renderApp();
    hydrateNamed();

    await userEvent.click(screen.getByText(/1 of 1 in split/i));
    await userEvent.click(await screen.findByLabelText('More actions for old-name'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));

    const input = await screen.findByLabelText('New name');
    await userEvent.clear(input);
    await userEvent.type(input, 'new-name');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    assert.strictEqual(posted().some((m) => m.t === 'rename-session'), false);
  });
});
