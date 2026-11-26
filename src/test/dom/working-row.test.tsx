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
    layout: layoutOf(['a']),
    snapshots: [snapshot('a', { status, items })],
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

const ASKED: TranscriptItem = { id: 'u1', ts: secondsAgo(5), role: 'user', text: 'fix the scroll' };

suite('WorkingRow', () => {
  test('an idle session shows no activity line', () => {
    renderApp();
    hydrate('idle', [ASKED]);

    assert.strictEqual(screen.queryByText('Working…') === null, true);
  });

  test('a running turn that has emitted nothing yet says Working', () => {
    renderApp();
    hydrate('running', [ASKED]);

    screen.getByText('Working…');
  });

  test('the big clock runs from the user message, so a reload does not reset it', () => {
    renderApp();
    hydrate('running', [{ ...ASKED, ts: secondsAgo(75) }]);

    screen.getByText('1:15');
  });

  test('streaming assistant text keeps the line, naming it Writing', () => {
    renderApp();
    hydrate('running', [ASKED, { id: 'a1', ts: secondsAgo(1), role: 'assistant', text: 'Look' }]);

    screen.getByText('Writing…');
    screen.getByText('Look');
  });

  test('a token-streaming backend shows its text as it arrives, half-written tail included', () => {
    renderApp();
    hydrate('running', [ASKED, { id: 'a1', ts: secondsAgo(1), role: 'assistant', text: 'First line.\nSecond li' }]);

    screen.getByText(/Second li/);
  });

  test('assistant text appears whole once the turn is over', () => {
    renderApp();
    hydrate('idle', [ASKED, { id: 'a1', ts: secondsAgo(1), role: 'assistant', text: 'Look' }]);

    screen.getByText('Look');
  });

  test('a thinking-only assistant item reads as Thinking', () => {
    renderApp();
    hydrate('running', [ASKED, { id: 'a1', ts: secondsAgo(1), role: 'assistant', text: '', thinking: 'hm' }]);

    screen.getByText('Thinking…');
  });

  test('a running tool names the step', () => {
    renderApp();
    hydrate('running', [ASKED, tool({ id: 't1', ts: secondsAgo(1), state: 'running' })]);

    screen.getByTitle('Bash · yarn test:unit');
  });

  test('the gap after a finished tool reads as Thinking', () => {
    renderApp();
    hydrate('running', [ASKED, tool({ id: 't1', ts: secondsAgo(3), state: 'ok' })]);

    screen.getByText('Thinking…');
  });

  test('a long-lived last item is not silence while it is the live one', () => {
    renderApp();
    hydrate('running', [{ ...ASKED, ts: secondsAgo(125) }]);

    assert.strictEqual(screen.queryByText(/no activity/) === null, true);
  });

  test('a custom provider instance of the claude kind shows text whole, whatever its id', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [summary('a', { status: 'running', providerId: 'work-account' })],
      layout: layoutOf(['a']),
      snapshots: [snapshot('a', { status: 'running', providerId: 'work-account', items: [ASKED, { id: 'a1', ts: secondsAgo(1), role: 'assistant', text: 'First line.\nSecond li' }] })],
      catalog: catalog().map((p) => ({ ...p, id: 'work-account', kind: 'claude' as const })),
      unavailable: [],
      usage: {},
    });

    screen.getByText(/Second li/);
  });

  test('a session awaiting approval shows no activity line — the approval card and status already say so', () => {
    renderApp();
    hydrate('awaiting-approval', [ASKED]);

    assert.strictEqual(screen.queryByText('Working…') === null, true);
    assert.strictEqual(screen.queryByText('Waiting for you') === null, true);
  });

  test('the elapsed count is not announced, so it cannot chatter once a second', () => {
    renderApp();
    hydrate('running', [{ ...ASKED, ts: secondsAgo(9) }]);

    const el = screen.getByText('0:09');
    assert.strictEqual(el.closest('[aria-live]') === null, true);
    assert.strictEqual(el.getAttribute('aria-hidden'), 'true');
  });
});
