import * as assert from 'node:assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { posted, renderReview, resetHost, sendFromHost } from './review-harness';

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
    // The count must never let a filter read as an empty fleet. Scoped to
    // the visible count span — the sr-only live region echoes the same
    // sentence, and both now match `/1 of 2/`.
    assert.strictEqual(screen.getAllByText(/1 of 2/).length, 2);
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

  test('an empty result never claims "no match" when the cap withheld files, and offers a way out', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({
      t: 'fleet-diff',
      trees: [{
        root: '/repo', branch: 'main', sessions: ['s1'],
        base: { kind: 'head' }, omitted: 200,
        files: [{ path: 'src/app.tsx', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] }],
      }],
    } as never);

    await user.type(screen.getByRole('textbox', { name: /Filter/ }), 'zzzz');

    assert.strictEqual(screen.queryByText('No file matches this filter.') === null, true);
    assert.strictEqual(
      screen.getByText('No file matches this filter among the files loaded so far.').textContent,
      'No file matches this filter among the files loaded so far.',
    );
    const showMore = screen.getByRole('button', { name: 'Show 200 more' });
    await user.click(showMore);
    assert.strictEqual(
      posted().some((m) => m.t === 'request-fleet-diff' && (m as { cap?: number }).cap === 1000),
      true,
    );
  });

  test('a filter that empties one tree drops it rather than leaving a header over nothing', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({
      t: 'fleet-diff',
      trees: [
        {
          root: '/repo-a', branch: 'main', sessions: ['s1'], base: { kind: 'head' }, omitted: 0,
          files: [{ path: 'src/app.tsx', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] }],
        },
        {
          root: '/repo-b', branch: 'main', sessions: ['s1'], base: { kind: 'head' }, omitted: 0,
          files: [{ path: 'README.md', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] }],
        },
      ],
    } as never);

    await user.type(screen.getByRole('textbox', { name: /Filter/ }), 'readme');

    assert.strictEqual(screen.queryByText('repo-a') === null, true);
    assert.strictEqual(screen.getByText('repo-b').textContent, 'repo-b');
  });

  test('clearing the filter is a control, not just deleting text by hand', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);

    const filter = screen.getByRole('textbox', { name: /Filter/ });
    await user.type(filter, 'readme');
    assert.strictEqual((filter as HTMLInputElement).value, 'readme');

    await user.click(screen.getByRole('button', { name: 'Clear filter' }));

    assert.strictEqual((filter as HTMLInputElement).value, '');
    assert.strictEqual(screen.queryByRole('button', { name: 'Clear filter' }) === null, true);
  });

  test('a filter change is echoed in a live region, but a background poll does not re-announce it', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);

    await user.type(screen.getByRole('textbox', { name: /Filter/ }), 'readme');
    const region = document.querySelector('[aria-live="polite"].sr-only');
    assert.strictEqual(region !== null, true);
    assert.strictEqual(region?.textContent?.includes('1 of 2'), true);

    // A background poll updates the visible count without touching the
    // filter — must not change the live region's text.
    const before = region?.textContent;
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);
    assert.strictEqual(region?.textContent, before);
  });
});
