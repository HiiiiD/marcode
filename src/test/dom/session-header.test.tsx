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

  test('only the header badge is a live region, not the roster count', () => {
    renderApp();
    hydrate();
    sendFromHost({ t: 'session-status', id: 'a', status: 'awaiting-approval' });

    const badge = screen.getByText('Needs you');
    assert.strictEqual(badge.closest('[aria-live]')?.getAttribute('aria-live'), 'polite');

    const rosterCount = screen.getByText(/1 needs you/i);
    assert.strictEqual(rosterCount.closest('[aria-live]'), null);
  });

  test('the header shows the folder the agent is working in', () => {
    renderApp();
    hydrate({ cwd: '/repos/hiiiid-code' });

    screen.getByText('hiiiid-code');
    assert.strictEqual(
      screen.getByText('hiiiid-code').getAttribute('title'), '/repos/hiiiid-code',
      'the basename is what fits at 300px; the full path is the tooltip',
    );
  });

  test('token usage is shown once there is any', () => {
    renderApp();
    hydrate({ usage: { inputTokens: 12000, outputTokens: 3400 } });

    screen.getByText('15.4k tokens');
  });

  test('usage is hidden at zero rather than shown as 0', () => {
    renderApp();
    hydrate();
    assert.strictEqual(screen.queryByText(/tokens/), null);
  });

  test('the title wins the space contest, not the model label', () => {
    renderApp();
    hydrate();

    const title = screen.getByTitle('Session a');
    assert.ok(title.className.includes('truncate'));
    const model = screen.getByText(/Fake Large/);
    assert.ok(model.className.includes('truncate'), 'the model label must be able to shrink too');
  });
});
