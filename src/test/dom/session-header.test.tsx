import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { renderApp, sendFromHost } from './harness';

function hydrate(over = {}) {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a', over)],
    layout: layoutOf('a'),
    snapshots: [snapshot('a', over)],
    catalog: catalog(),
  });
}

suite('SessionHeader status', () => {
  test('status is announced as text, not colour alone', () => {
    renderApp();
    hydrate();
    sendFromHost({ t: 'session-status', id: 'a', status: 'awaiting-approval' });

    const live = screen.getByText('Needs you');
    assert.strictEqual(live.closest('[aria-live]')?.getAttribute('aria-live'), 'polite');
  });

  test('awaiting-approval and error read differently', () => {
    renderApp();
    hydrate();
    sendFromHost({ t: 'session-status', id: 'a', status: 'error' });
    screen.getByText('Failed');
    assert.strictEqual(screen.queryByText('Needs you'), null);
  });

  test('the roster trigger counts sessions that need the user', () => {
    renderApp();
    hydrate();
    sendFromHost({ t: 'session-status', id: 'a', status: 'awaiting-approval' });

    screen.getByText(/1 needs you/i);
  });
});
