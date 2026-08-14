import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { catalog, layoutOf, snapshot, summary, tool } from '../fixtures/protocol';
import { renderApp, sendFromHost } from './harness';
import type { SessionStatus, TranscriptItem } from '../../protocol/messages';

/**
 * The row measures dead air from the last item's host timestamp, so fixtures
 * date their items relative to now rather than to the epoch.
 */
const secondsAgo = (n: number) => Date.now() - n * 1000;

function hydrate(status: SessionStatus, items: TranscriptItem[]) {
  sendFromHost({
    t: 'hydrate',
    sessions: [summary('a', { status })],
    layout: layoutOf('a'),
    snapshots: [snapshot('a', { status, items })],
    catalog: catalog(),
    usage: {},
  });
}

const ASKED: TranscriptItem = { id: 'u1', ts: secondsAgo(5), role: 'user', text: 'fix the scroll' };

suite('WorkingRow', () => {
  test('an idle session shows no working row', () => {
    renderApp();
    hydrate('idle', [ASKED]);

    assert.strictEqual(screen.queryByText('Working…'), null);
  });

  test('a running turn that has emitted nothing yet shows the row', () => {
    renderApp();
    hydrate('running', [ASKED]);

    screen.getByText('Working…');
  });

  test('the row times the dead air from the last item, so a reload does not reset it', () => {
    renderApp();
    hydrate('running', [{ ...ASKED, ts: secondsAgo(75) }]);

    screen.getByText('1:15');
  });

  test('streaming assistant text replaces the row — the content is the signal', () => {
    renderApp();
    hydrate('running', [ASKED, { id: 'a1', ts: secondsAgo(1), role: 'assistant', text: 'Look' }]);

    assert.strictEqual(screen.queryByText('Working…'), null);
  });

  test('a running tool replaces the row — its own card already spins', () => {
    renderApp();
    hydrate('running', [ASKED, tool({ id: 't1', ts: secondsAgo(1), state: 'running' })]);

    assert.strictEqual(screen.queryByText('Working…'), null);
  });

  test('the gap after a finished tool is dead air, and shows the row', () => {
    renderApp();
    hydrate('running', [ASKED, tool({ id: 't1', ts: secondsAgo(3), state: 'ok' })]);

    screen.getByText('Working…');
  });

  test('a session awaiting approval shows no working row — it is blocked on the user', () => {
    renderApp();
    hydrate('awaiting-approval', [ASKED]);

    assert.strictEqual(screen.queryByText('Working…'), null);
  });

  test('the elapsed count is not announced, so it cannot chatter once a second', () => {
    renderApp();
    hydrate('running', [{ ...ASKED, ts: secondsAgo(9) }]);

    const el = screen.getByText('0:09');
    assert.strictEqual(el.closest('[aria-live]'), null);
    assert.strictEqual(el.getAttribute('aria-hidden'), 'true');
  });
});
