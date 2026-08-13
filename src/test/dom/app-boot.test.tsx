import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, sendFromHost } from './harness';

function hydrate(ids: string[]) {
  sendFromHost({
    t: 'hydrate',
    sessions: ids.map((id) => summary(id)),
    layout: layoutOf(...ids),
    snapshots: ids.map((id) => snapshot(id)),
    catalog: catalog(),
  });
}

suite('App boot', () => {
  test('renders Loading… until hydrate arrives', () => {
    renderApp();
    screen.getByText('Loading…');
  });

  test('mount posts ready once, and set-visible for an empty pane set', () => {
    renderApp();

    // App's hooks sit above the `!state.ready` early return, so its effects
    // run on mount even while Loading… is on screen — and child effects flush
    // before the parent's, so this set-visible precedes ready.
    assert.deepStrictEqual(posted().filter((m) => m.t === 'ready'), [{ t: 'ready' }]);
    assert.deepStrictEqual(
      posted().filter((m) => m.t === 'set-visible'),
      [{ t: 'set-visible', sessionIds: [] }],
    );
  });

  test('hydrate renders a pane per layout entry', () => {
    renderApp();
    hydrate(['a', 'b']);

    assert.strictEqual(screen.queryByText('Loading…'), null);
    screen.getByLabelText('Session: Session a');
    screen.getByLabelText('Session: Session b');
  });

  test('hydrate posts set-visible carrying the layout session ids', () => {
    renderApp();
    hydrate(['a', 'b']);

    // Two: the empty one from mount, then the real one once panes exist.
    const visible = posted().filter((m) => m.t === 'set-visible');
    assert.strictEqual(visible.length, 2);
    assert.deepStrictEqual(visible.at(-1), { t: 'set-visible', sessionIds: ['a', 'b'] });
  });

  test('an empty roster renders the empty state', () => {
    renderApp();
    hydrate([]);

    screen.getByText('No open sessions.');
  });
});
