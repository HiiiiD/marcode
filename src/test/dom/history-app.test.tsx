import * as assert from 'node:assert';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatWhen } from '../../history/format-when';
import { summary } from '../fixtures/protocol';
import { posted, renderHistory, resetHost, sendFromHost } from './history-harness';
import type { SessionSummary } from '../../protocol/messages';

const sessions = (): SessionSummary[] => [
  summary('a', {
    title: 'Alpha', name: 'alpha-name', createdAt: 10, updatedAt: 300,
    summary: { text: 'Fixes login redirect', forUpdatedAt: 300 },
  }),
  summary('b', { title: 'Beta', name: 'beta-name', createdAt: 30, updatedAt: 100 }),
  summary('c', {
    title: 'Gamma', name: 'gamma-name', createdAt: 20, updatedAt: 200, archived: true,
    summary: { text: 'Flaky test hunt', forUpdatedAt: 200 },
  }),
  summary('d', { title: 'Delta', name: 'delta-name', createdAt: 5, updatedAt: 1, pinned: true }),
];

const hydrate = (list: SessionSummary[]) => {
  sendFromHost({ t: 'hydrate', sessions: list } as never);
};

// Row order as a list of the titles found, top to bottom. Strings only — never a node.
const order = (): string[] => {
  const titles = ['Alpha', 'Beta', 'Gamma', 'Delta'];
  return screen.getAllByRole('row')
    .map((row) => titles.find((t) => (row.textContent ?? '').includes(t)))
    .filter((t): t is string => t !== undefined);
};

suite('history app', () => {
  setup(() => { resetHost(); });

  test('posts ready, then asks for summaries', () => {
    renderHistory();
    const tags = posted().map((m) => m.t);
    assert.deepStrictEqual(tags.slice(0, 2), ['ready', 'request-history-summaries']);
  });

  test('pinned first, then by last updated, newest first', () => {
    renderHistory();
    hydrate(sessions());
    assert.deepStrictEqual(order(), ['Delta', 'Alpha', 'Gamma', 'Beta']);
    assert.strictEqual(screen.getByText('Pinned').textContent, 'Pinned');
  });

  test('a row shows dates, provider and model, archived state and the summary', () => {
    renderHistory();
    hydrate(sessions());
    assert.strictEqual(screen.getAllByText(formatWhen(300)).length >= 1, true);
    assert.strictEqual(screen.getAllByText(formatWhen(10)).length >= 1, true);
    assert.strictEqual(screen.getAllByText('fake · fake-large').length, 4);
    assert.strictEqual(screen.getByText('Fixes login redirect').textContent, 'Fixes login redirect');
    const gamma = screen.getAllByRole('row').find((r) => (r.textContent ?? '').includes('Gamma'))!;
    assert.strictEqual(within(gamma).queryByText('Archived') !== null, true);
    const alpha = screen.getAllByRole('row').find((r) => (r.textContent ?? '').includes('Alpha'))!;
    assert.strictEqual(within(alpha).queryByText('Archived') === null, true);
  });

  test('a session without a summary falls back to its title', () => {
    renderHistory();
    hydrate(sessions());
    assert.strictEqual(screen.getAllByText('Beta').length, 2);
  });

  test('sort by created, then flip the direction', async () => {
    renderHistory();
    hydrate(sessions());
    await userEvent.click(screen.getByRole('tab', { name: 'Created' }));
    assert.deepStrictEqual(order(), ['Delta', 'Beta', 'Gamma', 'Alpha']);
    await userEvent.click(screen.getByRole('button', { name: 'Sort ascending' }));
    assert.deepStrictEqual(order(), ['Delta', 'Alpha', 'Gamma', 'Beta']);
  });

  test('status tabs filter by archived', async () => {
    renderHistory();
    hydrate(sessions());
    await userEvent.click(screen.getByRole('tab', { name: 'Archived' }));
    assert.deepStrictEqual(order(), ['Gamma']);
    await userEvent.click(screen.getByRole('tab', { name: 'Active' }));
    assert.deepStrictEqual(order(), ['Delta', 'Alpha', 'Beta']);
  });

  test('the text filter matches summaries', async () => {
    renderHistory();
    hydrate(sessions());
    await userEvent.type(screen.getByRole('textbox', { name: 'Filter sessions' }), 'flaky');
    assert.deepStrictEqual(order(), ['Gamma']);
  });

  test('pin and unpin post set-pinned', async () => {
    renderHistory();
    hydrate(sessions());
    await userEvent.click(screen.getByRole('button', { name: 'Pin alpha-name' }));
    await userEvent.click(screen.getByRole('button', { name: 'Unpin delta-name' }));
    const pins = posted().filter((m) => m.t === 'set-pinned');
    assert.deepStrictEqual(pins, [
      { t: 'set-pinned', id: 'a', pinned: true },
      { t: 'set-pinned', id: 'd', pinned: false },
    ]);
  });

  test('Open posts focus-session', async () => {
    renderHistory();
    hydrate(sessions());
    await userEvent.click(screen.getByRole('button', { name: 'Open gamma-name' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'focus-session'), [
      { t: 'focus-session', id: 'c' },
    ]);
  });

  test('sessions-changed updates the rows', () => {
    renderHistory();
    hydrate(sessions());
    sendFromHost({
      t: 'sessions-changed',
      sessions: [summary('e', {
        title: 'Epsilon', name: 'eps-name', summary: { text: 'Fresh work', forUpdatedAt: 1 },
      })],
    } as never);
    assert.strictEqual(screen.getByText('Epsilon').textContent, 'Epsilon');
    assert.strictEqual(screen.queryByText('Alpha') === null, true);
  });

  test('empty states differ for no sessions and no matches', async () => {
    renderHistory();
    hydrate([]);
    assert.strictEqual(screen.getByText('No sessions yet').textContent, 'No sessions yet');
    hydrate(sessions());
    await userEvent.type(screen.getByRole('textbox', { name: 'Filter sessions' }), 'zzzz');
    assert.strictEqual(screen.getByText('No sessions match').textContent, 'No sessions match');
  });
});
