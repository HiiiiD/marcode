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
    unavailable: [],
    usage: {},
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
    unavailable: [],
    usage: {},
  });
}

suite('accessibility sweep', () => {
  test('hide buttons are distinguishable from each other', () => {
    renderApp();
    hydrateTwoPanes();

    screen.getByLabelText('Hide Session a from the split');
    screen.getByLabelText('Hide Session b from the split');
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
    const bypass = await screen.findByRole('menuitemradio', { name: /bypass/i });
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

  /**
   * The model can be switched at any point in a conversation: `Query.setModel`
   * retargets the live run (see claude-provider.ts), so no pane may freeze the
   * control after its first message, and none may carry a leftover
   * `aria-describedby` pointing at a reason that no longer renders — a dangling
   * reference announces nothing and reads to assistive tech as a broken label.
   * Asserted across two panes because the earlier disabled state was
   * session-scoped per pane; a single-pane test could not see one pane freeze
   * while the other stayed live.
   */
  test('the model control stays live in every pane once messages exist', async () => {
    renderApp();
    hydrateTwoPanes();
    for (const id of ['a', 'b']) {
      sendFromHost({
        t: 'session-patch',
        id,
        patch: { op: 'append', item: { id: `i-${id}`, ts: 1, role: 'user', text: 'go' } },
      });
    }

    const triggers = screen.getAllByLabelText('Model') as HTMLButtonElement[];
    assert.strictEqual(triggers.length, 2);
    for (const trigger of triggers) {
      assert.strictEqual(trigger.disabled, false, 'a started session can still switch model');
      assert.strictEqual(trigger.getAttribute('aria-describedby'), null);
    }
  });
});
