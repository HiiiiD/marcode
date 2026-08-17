import * as assert from 'node:assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderReview, resetHost, sendFromHost } from './review-harness';

const TREES = [{
  root: '/repo', branch: 'main', sessions: ['s1', 's2'],
  base: { kind: 'head' }, omitted: 0,
  files: [
    { path: 'src/app.tsx', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] },
    { path: 'README.md', op: 'modify', insertions: 2, deletions: 0, claimedBy: ['s1', 's2'] },
  ],
}];

suite('review filter', () => {
  setup(() => { resetHost(); });

  test('narrows the rows and says so in the count', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);

    await user.type(screen.getByRole('textbox', { name: /Filter/ }), 'readme');

    assert.strictEqual(screen.queryAllByRole('button', { name: /src\/app\.tsx/ }).length, 0);
    // README.md is claimed by both s1 and s2, so it renders under both session
    // groups by design (see `groupTree`'s own tests: "a file two sessions
    // claim appears under both"). The filter narrows which *files* pass, not
    // how a passing file is grouped, so the row count here is 2, not 1 — the
    // file count (queried separately below) is what stays at 1.
    assert.strictEqual(screen.queryAllByRole('button', { name: /README\.md/ }).length, 2);
    // The count must never let a filter read as an empty fleet.
    assert.strictEqual(screen.getByText(/1 of 2/).textContent?.includes('1 of 2'), true);
  });

  test('an empty result explains itself as a filter, not as a clean fleet', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);

    await user.type(screen.getByRole('textbox', { name: /Filter/ }), 'zzzz');

    assert.strictEqual(screen.getByText('No file matches this filter.').textContent,
      'No file matches this filter.');
  });

  test('contested-only keeps the file two sessions claimed', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);

    await user.click(screen.getByRole('button', { name: /Contested only/ }));

    assert.strictEqual(screen.queryAllByRole('button', { name: /src\/app\.tsx/ }).length, 0);
    assert.strictEqual(screen.queryAllByRole('button', { name: /README\.md/ }).length > 0, true);
  });
});
