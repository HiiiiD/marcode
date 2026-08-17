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

// Same tree, with a file inserted ahead of `b.ts` — everything after it shifts
// down one slot. Used to prove the roving index follows the row it was on,
// not the slot it was in.
const TREES_SHIFTED = [{
  root: '/repo', branch: 'main', sessions: ['s1'],
  base: { kind: 'head' }, omitted: 0,
  files: [
    { path: 'a.ts', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] },
    { path: 'new.ts', op: 'create', insertions: 1, deletions: 0, claimedBy: ['s1'] },
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

  test('on a fresh tab, next-file opens the current row rather than skipping past it', async () => {
    // Nothing has been focused or opened yet, so the roving index's default
    // (`0`, from `useRovingRows`) is not a real reading position — advancing
    // from it with a plain "next" would open a.ts, the row `active` already
    // (nominally) points to. The first press must open that row, not skip
    // past it to b.ts.
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);
    resetHost();

    await user.click(screen.getByRole('button', { name: 'Open the next file' }));

    let opened = posted().filter((m) => m.t === 'open-file-diff');
    assert.strictEqual(opened.length, 1);
    assert.strictEqual((opened[0] as { path: string }).path, 'a.ts');

    // Once the list has genuine focus (openRow above moved it there),
    // "next" resumes ordinary next-row movement.
    resetHost();
    await user.click(screen.getByRole('button', { name: 'Open the next file' }));
    opened = posted().filter((m) => m.t === 'open-file-diff');
    assert.strictEqual(opened.length, 1);
    assert.strictEqual((opened[0] as { path: string }).path, 'b.ts');
  });

  test('prev-file opens the row before the active one', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);

    // Land on b.ts first, the same way ArrowDown or a click would.
    await user.click(screen.getByRole('button', { name: /b\.ts/ }));
    resetHost();

    await user.click(screen.getByRole('button', { name: 'Open the previous file' }));

    const opened = posted().filter((m) => m.t === 'open-file-diff');
    assert.strictEqual(opened.length, 1);
    assert.strictEqual((opened[0] as { path: string }).path, 'a.ts');
  });

  test('the roving index follows the row, not the slot, when the list reorders underneath it', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);

    // Focus b.ts while it sits at index 1.
    await user.click(screen.getByRole('button', { name: /b\.ts/ }));

    // A poll lands mid-review with a file that now sorts ahead of it — b.ts
    // is still the same file, but its index has shifted from 1 to 2.
    sendFromHost({ t: 'fleet-diff', trees: TREES_SHIFTED } as never);

    assert.strictEqual(
      screen.getByRole('button', { name: /b\.ts/ }).getAttribute('tabindex'), '0',
    );
    assert.strictEqual(
      screen.getByRole('button', { name: /new\.ts/ }).getAttribute('tabindex'), '-1',
    );
    assert.strictEqual(
      screen.getByRole('button', { name: /^a\.ts/ }).getAttribute('tabindex'), '-1',
    );
  });

  test('focus survives the active row disappearing from an updated diff', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);

    await user.click(screen.getByRole('button', { name: /b\.ts/ }));

    // The tree re-reads (the 750ms poll every session write triggers) and
    // b.ts is gone — reverted, or nobody claims it any more. Nothing the
    // user did moved focus away from it; the row's own node just unmounted
    // out from under a focused list.
    sendFromHost({
      t: 'fleet-diff', trees: [{ ...TREES[0], files: [TREES[0].files[0]] }],
    } as never);

    // Must not be left on `document.body` — the next Tab press has to resume
    // inside the list, not re-enter the page's tab order from the top.
    assert.strictEqual(document.activeElement === document.body, false);
    assert.strictEqual(document.activeElement?.textContent?.includes('a.ts'), true);
  });

  test('rows carry their position and the set size for a screen reader', () => {
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);

    const rows = [...document.querySelectorAll('[data-review-row]')];
    const listItems = rows.map((row) => row.closest('li'));
    assert.strictEqual(listItems.every((li) => li !== null), true);
    assert.strictEqual(listItems[0]?.getAttribute('aria-posinset'), '1');
    assert.strictEqual(listItems[0]?.getAttribute('aria-setsize'), '2');
    assert.strictEqual(listItems[1]?.getAttribute('aria-posinset'), '2');
    assert.strictEqual(listItems[1]?.getAttribute('aria-setsize'), '2');
  });

  test('ArrowDown on the tree collapse chevron does not steal focus into a row', async () => {
    const user = userEvent.setup();
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);

    const chevron = screen.getByRole('button', { name: /Collapse repo/ });
    chevron.focus();
    await user.keyboard('{ArrowDown}');

    // Focus must still be on the chevron — the scroll container's key
    // handler only acts on a row's own key events, not on any focused
    // descendant.
    assert.strictEqual(document.activeElement === chevron, true);
  });
});
