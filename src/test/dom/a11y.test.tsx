import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { renderApp, sendFromHost } from './harness';

/** Two sessions in the roster, both open in their own pane. */
function hydrateTwoPanes() {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a'), summary('b')],
    layout: layoutOf('a', 'b'),
    snapshots: [snapshot('a'), snapshot('b')],
    catalog: catalog(),
  });
}

/** One session in the roster, in its own pane. */
function hydrateOne() {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a')],
    layout: layoutOf('a'),
    snapshots: [snapshot('a')],
    catalog: catalog(),
  });
}

suite('accessibility sweep', () => {
  test('close buttons are distinguishable from each other', () => {
    renderApp();
    hydrateTwoPanes();

    screen.getByLabelText('Close session Session a');
    screen.getByLabelText('Close session Session b');
  });

  test('resize handles name the panes they sit between', () => {
    renderApp();
    hydrateTwoPanes();

    screen.getByLabelText('Resize between Session a and Session b');
  });

  test('the disabled-bypass reason is available without hover', async () => {
    renderApp();
    hydrateOne();
    sendFromHost({
      t: 'session-patch',
      id: 'a',
      patch: {
        op: 'append',
        item: {
          id: '1', ts: 1, role: 'user', text: 'go',
        },
      },
    });

    await userEvent.click(screen.getByLabelText('Permission mode'));
    const bypass = await screen.findByRole('option', { name: /bypass/i });
    assert.ok(
      bypass.getAttribute('aria-describedby'),
      'a title on a disabled option is not reliably announced',
    );
  });

  test('the panel has a heading structure', () => {
    renderApp();
    hydrateTwoPanes();

    assert.strictEqual(screen.getAllByRole('heading').length, 2, 'one heading per pane');
  });
});
