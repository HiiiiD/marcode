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

  test('a row shows last updated, provider and model; summary is collapsed', () => {
    renderHistory();
    hydrate(sessions());
    assert.strictEqual(screen.getAllByText(formatWhen(300)).length >= 1, true);
    assert.strictEqual(screen.getAllByText('fake · fake-large').length, 4);
    assert.strictEqual(screen.queryByText('Fixes login redirect') === null, true);
  });

  test('expanding a row reveals its summary and created date', async () => {
    renderHistory();
    hydrate(sessions());
    await userEvent.click(screen.getByRole('button', { name: 'Expand alpha-name' }));
    assert.strictEqual(screen.getByText('Fixes login redirect').textContent, 'Fixes login redirect');
    assert.strictEqual(screen.getByRole('button', { name: 'Collapse alpha-name' }).getAttribute('aria-expanded'), 'true');
  });

  test('a session without a summary falls back to its title when expanded', async () => {
    renderHistory();
    hydrate(sessions());
    await userEvent.click(screen.getByRole('button', { name: 'Expand beta-name' }));
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

  test('an open session shows a disabled Opened button', async () => {
    renderHistory();
    hydrate([summary('a', { name: 'alpha-name', open: true }), summary('b', { name: 'beta-name' })]);
    const btn = screen.getByRole('button', { name: 'Opened alpha-name' });
    assert.strictEqual((btn as HTMLButtonElement).disabled, true);
    assert.strictEqual(btn.textContent, 'Opened');
    assert.strictEqual((screen.getByRole('button', { name: 'Open beta-name' }) as HTMLButtonElement).disabled, false);
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

  test('hidden blocked sessions are identifiable, filterable and stoppable without opening a pane', async () => {
    renderHistory();
    const blocked = summary('blocked', {
      title: 'Platform worker', name: 'opencode-hidden-worker', status: 'awaiting-approval', open: false,
    });
    hydrate([
      blocked,
      summary('question', { name: 'question-worker', status: 'awaiting-approval', waitingOn: 'question' }),
      summary('running', { name: 'running-worker', status: 'running' }),
      summary('error', { name: 'failed-worker', status: 'error' }),
      summary('idle', { name: 'idle-worker', status: 'idle' }),
    ]);
    assert.strictEqual(screen.getByRole('columnheader', { name: 'Status' }).textContent, 'Status');
    assert.strictEqual(screen.getByText('opencode-hidden-worker').textContent, 'opencode-hidden-worker');
    assert.strictEqual(screen.getByText('Waiting for approval').textContent, 'Waiting for approval');
    assert.strictEqual(screen.getByText('Waiting for answer').textContent, 'Waiting for answer');
    assert.strictEqual(screen.getByText('Running').textContent, 'Running');
    assert.strictEqual(screen.queryByRole('button', { name: 'Stop idle-worker' }) === null, true);
    assert.strictEqual(screen.queryByRole('button', { name: 'Stop failed-worker' }) === null, true);

    await userEvent.click(screen.getByRole('button', { name: 'Needs attention' }));
    assert.strictEqual(screen.getByRole('button', { name: 'Needs attention' }).getAttribute('aria-pressed'), 'true');
    assert.strictEqual(screen.queryByText('running-worker') === null, true);
    assert.strictEqual(screen.queryByText('idle-worker') === null, true);
    assert.strictEqual(screen.getByText('failed-worker').textContent, 'failed-worker');
    await userEvent.type(screen.getByRole('textbox', { name: 'Filter sessions' }), 'opencode-hidden');
    assert.strictEqual(screen.queryByText('question-worker') === null, true);
    await userEvent.click(screen.getByRole('button', { name: 'Stop opencode-hidden-worker' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'interrupt'), [{ t: 'interrupt', id: 'blocked' }]);
    assert.strictEqual(posted().some((m) => m.t === 'focus-session'), false);

    sendFromHost({ t: 'sessions-changed', sessions: [{ ...blocked, status: 'idle' }] });
    assert.strictEqual(screen.queryByText('Platform worker') === null, true);
    assert.strictEqual(screen.getByText('No sessions match').textContent, 'No sessions match');
    await userEvent.click(screen.getByRole('button', { name: 'Needs attention' }));
    assert.strictEqual(screen.getByText('Idle').textContent, 'Idle');
    assert.strictEqual(screen.queryByRole('button', { name: 'Stop opencode-hidden-worker' }) === null, true);
  });

  test('running sessions can be stopped but a foreign session cannot be interrupted here', async () => {
    renderHistory();
    hydrate([
      summary('running', { name: 'running-worker', status: 'running' }),
      summary('foreign', { name: 'foreign-worker', status: 'awaiting-approval', owner: { host: 'tui', pid: 123 } }),
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Stop running-worker' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'interrupt'), [{ t: 'interrupt', id: 'running' }]);
    assert.strictEqual((screen.getByRole('button', { name: 'Stop foreign-worker' }) as HTMLButtonElement).disabled, true);
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
