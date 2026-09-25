import * as assert from 'node:assert';
import { screen } from '@testing-library/react';
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
    title: 'Gamma', name: 'gamma-name', createdAt: 20, updatedAt: 200,
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

  test('a row shows dates, provider and model, and the summary', () => {
    renderHistory();
    hydrate(sessions());
    assert.strictEqual(screen.getAllByText(formatWhen(300)).length >= 1, true);
    assert.strictEqual(screen.getAllByText(formatWhen(10)).length >= 1, true);
    assert.strictEqual(screen.getAllByText('fake · fake-large').length, 4);
    assert.strictEqual(screen.getByText('Fixes login redirect').textContent, 'Fixes login redirect');
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

suite('history memory actions', () => {
  setup(() => { resetHost(); });

  test('nothing memory-related renders until the host says memory is enabled', () => {
    renderHistory();
    hydrate(sessions());
    assert.strictEqual(screen.queryByRole('button', { name: 'Index memory' }) === null, true);
    assert.strictEqual(screen.queryByRole('button', { name: 'Re-summarize alpha-name' }) === null, true);
  });

  test('with memory enabled a row can be re-summarized', async () => {
    renderHistory();
    hydrate(sessions());
    sendFromHost({ t: 'memory-status', enabled: true, llm: false });
    await userEvent.click(await screen.findByRole('button', { name: 'Re-summarize alpha-name' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'memory-resummarize'), [
      { t: 'memory-resummarize', id: 'a' },
    ]);
  });

  test('without an llm summarizer the bulk action reindexes immediately', async () => {
    renderHistory();
    hydrate(sessions());
    sendFromHost({ t: 'memory-status', enabled: true, llm: false });
    await userEvent.click(await screen.findByRole('button', { name: 'Index memory' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'memory-reindex'), [
      { t: 'memory-reindex', scope: 'missing-llm' },
    ]);
  });

  test('with an llm summarizer the bulk action asks for the estimate and waits for confirmation', async () => {
    renderHistory();
    hydrate(sessions());
    sendFromHost({ t: 'memory-status', enabled: true, llm: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Index memory' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'memory-estimate'), [
      { t: 'memory-estimate', scope: 'missing-llm' },
    ]);
    assert.strictEqual(posted().some((m) => m.t === 'memory-reindex'), false);
    sendFromHost({ t: 'memory-estimate', scope: 'missing-llm', sessions: 120, approxInputTokens: 360000 });
    assert.strictEqual(
      (await screen.findByText('Summarize 120 sessions (~360k tokens)?')).textContent,
      'Summarize 120 sessions (~360k tokens)?',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'memory-reindex'), [
      { t: 'memory-reindex', scope: 'missing-llm' },
    ]);
  });

  test('with an llm summarizer a full rebuild can be started from the strip', async () => {
    renderHistory();
    hydrate(sessions());
    sendFromHost({ t: 'memory-status', enabled: true, llm: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Rebuild all' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'memory-estimate'), [
      { t: 'memory-estimate', scope: 'all' },
    ]);
    sendFromHost({ t: 'memory-estimate', scope: 'all', sessions: 300, approxInputTokens: 900000 });
    await userEvent.click(await screen.findByRole('button', { name: 'Start' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'memory-reindex'), [
      { t: 'memory-reindex', scope: 'all' },
    ]);
  });

  test('without an llm summarizer there is no full-rebuild button', async () => {
    renderHistory();
    hydrate(sessions());
    sendFromHost({ t: 'memory-status', enabled: true, llm: false });
    await screen.findByRole('button', { name: 'Index memory' });
    assert.strictEqual(screen.queryByRole('button', { name: 'Rebuild all' }) === null, true);
  });

  test('progress shows the phase and can be stopped', async () => {
    renderHistory();
    hydrate(sessions());
    sendFromHost({ t: 'memory-status', enabled: true, llm: true });
    sendFromHost({ t: 'memory-progress', phase: 'llm', done: 3, total: 10 });
    assert.strictEqual((await screen.findByText('Summarizing 3/10')).textContent, 'Summarizing 3/10');
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'memory-cancel'), [{ t: 'memory-cancel' }]);
  });

  test('done clears the progress strip', async () => {
    renderHistory();
    hydrate(sessions());
    sendFromHost({ t: 'memory-status', enabled: true, llm: true });
    sendFromHost({ t: 'memory-progress', phase: 'llm', done: 3, total: 10 });
    sendFromHost({ t: 'memory-progress', phase: 'done', done: 10, total: 10 });
    assert.strictEqual(screen.queryByText('Summarizing 3/10') === null, true);
    assert.strictEqual(screen.queryByRole('button', { name: 'Index memory' }) !== null, true);
  });
});
