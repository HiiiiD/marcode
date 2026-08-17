import * as assert from 'node:assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderReview, resetHost, sendFromHost } from './review-harness';

const TREES = [{
  root: '/repo', branch: 'main', sessions: ['s1'],
  base: { kind: 'head' }, omitted: 0,
  files: [
    { path: 'src/webview/a.tsx', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] },
    { path: 'src/webview/b.tsx', op: 'modify', insertions: 2, deletions: 1, claimedBy: ['s1'] },
  ],
}];

const READY = {
  t: 'hydrate',
  sessions: [{ id: 's1', title: 'Session A', status: 'idle' }],
  layout: { panes: [], orientation: 'horizontal' },
};

suite('review structure', () => {
  setup(() => { resetHost(); });

  test('nests tree above session above file', () => {
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: TREES } as never);
    assert.strictEqual(screen.getByRole('heading', { level: 3 }).textContent?.includes('repo'), true);
    assert.strictEqual(screen.getByRole('heading', { level: 4 }).textContent?.includes('Session A'), true);
  });

  test('names the shared directory once instead of on every row', () => {
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: TREES } as never);
    assert.strictEqual(screen.getByText('src/webview/').textContent, 'src/webview/');
    assert.strictEqual(screen.queryAllByText('src/webview/').length, 1);
  });

  test('counts the files in a session group', () => {
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: TREES } as never);
    assert.strictEqual(screen.getByText('2 files').textContent, '2 files');
  });

  test('collapsing a session group hides its rows and keeps its header', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost(READY as never, { t: 'fleet-diff', trees: TREES } as never);

    await user.click(screen.getByRole('button', { name: /Collapse Session A/ }));

    assert.strictEqual(screen.queryAllByRole('button', { name: /a\.tsx/ }).length, 0);
    assert.strictEqual(screen.getByRole('heading', { level: 4 }).textContent?.includes('Session A'), true);
  });
});
