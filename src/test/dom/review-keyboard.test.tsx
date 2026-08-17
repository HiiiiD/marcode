import * as assert from 'node:assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { posted, renderReview, resetHost, sendFromHost } from './review-harness';

const TREES = [{
  root: '/repo', branch: 'main', sessions: ['s1'],
  base: { kind: 'head' }, omitted: 0,
  files: [
    { path: 'a.ts', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] },
    { path: 'b.ts', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] },
  ],
}];

suite('review keyboard', () => {
  setup(() => { resetHost(); });

  test('exactly one row is in the tab order', () => {
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);
    const rows = document.querySelectorAll('[data-review-row]');
    const tabbable = [...rows].filter((r) => r.getAttribute('tabindex') === '0');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(tabbable.length, 1);
  });

  test('ArrowDown moves focus to the next row', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);

    await user.click(screen.getByRole('button', { name: /a\.ts/ }));
    resetHost();
    await user.keyboard('{ArrowDown}');

    assert.strictEqual(document.activeElement?.textContent?.includes('b.ts'), true);
  });

  test('an opened row is marked as read', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);

    await user.click(screen.getByRole('button', { name: /a\.ts/ }));

    assert.strictEqual(posted().some((m) => m.t === 'open-file-diff'), true);
    assert.strictEqual(
      screen.getByRole('button', { name: /a\.ts/ }).getAttribute('data-opened'), 'true',
    );
    assert.strictEqual(
      screen.getByRole('button', { name: /b\.ts/ }).getAttribute('data-opened'), null,
    );
  });

  test('next-file opens without the user finding the row', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);
    resetHost();

    await user.click(screen.getByRole('button', { name: 'Open the next file' }));

    const opened = posted().filter((m) => m.t === 'open-file-diff');
    assert.strictEqual(opened.length, 1);
  });
});
