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
   * The model-disabled reason (session-header.tsx) is rendered once per
   * pane. A fixed, unqualified id would collide across panes —
   * `getElementById`, which is what `aria-describedby` resolves against,
   * returns only the first match in the document, so every pane after the
   * first would describe its disabled control using the wrong pane's reason
   * text. Session-scoping the id is what a single-pane test can never catch.
   * (The same defect and fix apply to the bypass-disabled reason in
   * composer.tsx — see composer.test.tsx, where opening a Select can
   * actually be driven through a click; react-resizable-panels' multi-panel
   * DOM defeats Base UI Select's click-to-open in this jsdom harness, which
   * is why that assertion isn't duplicated inside a full two-pane `renderApp`
   * here. Reading `aria-describedby` directly off the trigger, as below,
   * needs no click and isn't affected.)
   */
  test('the disabled-model reason id does not collide across panes', async () => {
    renderApp();
    hydrateTwoPanes();
    for (const id of ['a', 'b']) {
      sendFromHost({
        t: 'session-patch',
        id,
        patch: { op: 'append', item: { id: `i-${id}`, ts: 1, role: 'user', text: 'go' } },
      });
    }

    const triggers = screen.getAllByLabelText('Model');
    assert.strictEqual(triggers.length, 2);
    const describedByA = triggers[0].getAttribute('aria-describedby');
    const describedByB = triggers[1].getAttribute('aria-describedby');

    assert.ok(describedByA);
    assert.ok(describedByB);
    assert.notStrictEqual(describedByA, describedByB, 'each pane must own a distinct reason id');
    assert.ok(
      document.getElementById(describedByA!)?.textContent?.includes('before the first message'),
    );
    assert.ok(
      document.getElementById(describedByB!)?.textContent?.includes('before the first message'),
    );
  });
});
