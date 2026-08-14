import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, resetHost, sendFromHost } from './harness';

function hydrate() {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a')],
    layout: layoutOf('a'),
    snapshots: [snapshot('a')],
    catalog: catalog(),
    usage: {},
  });
}

suite('SessionCreateMenu', () => {
  setup(() => resetHost());

  test('creating with the defaults sends the first model and its default effort', async () => {
    renderApp();
    hydrate();

    await userEvent.click(screen.getByRole('button', { name: 'New session' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Create session' }));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'create-session',
      providerId: 'fake',
      cwd: '',
      model: 'fake-large',
      effort: 'medium',
    });
  });

  test('choosing a model without effort support omits effort', async () => {
    renderApp();
    hydrate();

    await userEvent.click(screen.getByRole('button', { name: 'New session' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Fake Small' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Create session' }));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'create-session', providerId: 'fake', cwd: '', model: 'fake-small',
    });
  });

  test('switching models resets a stale effort selection', async () => {
    renderApp();
    hydrate();

    await userEvent.click(screen.getByRole('button', { name: 'New session' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'high' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Fake Medium' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Create session' }));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'create-session',
      providerId: 'fake',
      cwd: '',
      model: 'fake-medium',
      effort: 'low',
    });
  });

  test('the trigger is disabled when no provider is available', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [],
      layout: { orientation: 'vertical', panes: [] },
      snapshots: [],
      catalog: [],
      usage: {},
    });

    // Two "New session" triggers exist here: the roster's persistent one and
    // the empty state's own (pane-group.tsx renders `<SessionCreateMenu />`
    // when the roster is empty) — both must be disabled when no provider is
    // available, since they share the same underlying menu.
    const triggers = screen.getAllByRole('button', { name: 'New session' });
    assert.strictEqual(triggers.length, 2);
    for (const trigger of triggers) {
      assert.ok((trigger as HTMLButtonElement).disabled);
    }
  });
});
