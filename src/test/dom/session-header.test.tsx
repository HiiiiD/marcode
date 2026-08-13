import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, sendFromHost } from './harness';

function hydrate(over = {}) {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a', over)],
    layout: layoutOf('a'),
    snapshots: [snapshot('a', over)],
    catalog: catalog(),
  });
}

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
    const model = screen.getByLabelText('Model');
    assert.ok(model.className.includes('truncate'), 'the model control must be able to shrink too');
  });

  test('the model label is a control that posts set-model', async () => {
    renderApp();
    hydrate();

    await userEvent.click(screen.getByLabelText('Model'));
    await userEvent.click(await screen.findByRole('option', { name: 'Fake Small' }));

    assert.deepStrictEqual(posted().at(-1), { t: 'set-model', id: 'a', model: 'fake-small' });
  });

  test('the model control is disabled once the session has started, with a reason for assistive tech', () => {
    renderApp();
    hydrate({ items: [{ id: 'u1', ts: 1, role: 'user', text: 'hi' }] });

    const model = screen.getByLabelText('Model') as HTMLButtonElement;
    assert.strictEqual(model.disabled, true);
    const describedBy = model.getAttribute('aria-describedby');
    assert.ok(describedBy, 'a disabled control must not rely on a title attribute for its reason');
    const reason = document.getElementById(describedBy!);
    assert.ok(reason, 'the aria-describedby target must be real, rendered text');
    assert.ok(/before the first message/i.test(reason!.textContent ?? ''));
  });

  test('the pane X removes the pane without archiving the session', async () => {
    renderApp();
    hydrateTwoPanes();

    await userEvent.click(screen.getByLabelText('Hide Session a from the split'));

    const layouts = posted().filter((m) => m.t === 'set-layout');
    assert.deepStrictEqual(layouts.at(-1)!.layout.panes.map((p) => p.sessionId), ['b']);
    assert.ok(
      !posted().some((m) => m.t === 'close-session'),
      'X means hide; archiving is a deliberate choice made from the roster',
    );
  });
});
