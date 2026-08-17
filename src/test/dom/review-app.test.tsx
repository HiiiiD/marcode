import * as assert from 'node:assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { posted, renderReview, resetHost, sendFromHost } from './review-harness';

suite('review app', () => {
  setup(() => { resetHost(); });

  test('renders a file row per change, and opens the diff on click', async () => {
    renderReview();
    sendFromHost({
      t: 'fleet-diff',
      trees: [{
        root: '/repo', branch: 'main', sessions: ['s1'],
        base: { kind: 'head' }, omitted: 0,
        files: [{ path: 'src/a.ts', op: 'modify', insertions: 3, deletions: 1, claimedBy: ['s1'] }],
      }],
    } as never);

    await userEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }));

    const open = posted().filter((m) => m.t === 'open-file-diff');
    assert.strictEqual(open.length, 1);
    assert.strictEqual(JSON.stringify(open[0]).includes('src/a.ts'), true);
  });

  test('posts ready on mount, then requests the fleet diff', () => {
    renderReview();
    assert.strictEqual(posted().some((m) => m.t === 'ready'), true);
    assert.strictEqual(posted().some((m) => m.t === 'request-fleet-diff'), true);
  });

  test('holds a loading state until the host answers', () => {
    renderReview();
    sendFromHost({ t: 'hydrate', sessions: [], layout: { panes: [], orientation: 'horizontal' } } as never);
    assert.strictEqual(screen.getByText('Reading the working trees…').tagName, 'P');
  });

  test('a failed read is a state, not a permanent loading line', () => {
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: [], reason: 'git exploded' } as never);
    assert.strictEqual(screen.getByText('Could not read the changes').textContent, 'Could not read the changes');
    assert.strictEqual(screen.getByText('git exploded').textContent, 'git exploded');
  });

  test('a successful read with no changes is its own state, not loading or error', () => {
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: [] } as never);
    assert.strictEqual(screen.getByText('Nothing to review').textContent, 'Nothing to review');
  });

  test('"show more" re-requests with a raised cap', async () => {
    renderReview();
    sendFromHost({
      t: 'fleet-diff',
      trees: [{
        root: '/repo', branch: 'main', sessions: ['s1'],
        base: { kind: 'head' }, omitted: 340,
        files: [{ path: 'src/a.ts', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] }],
      }],
    } as never);

    await userEvent.click(screen.getByRole('button', { name: 'Show 340 more' }));

    const raised = posted().filter((m) => m.t === 'request-fleet-diff' && m.cap !== undefined);
    assert.strictEqual(raised.length, 1);
    assert.strictEqual((raised[0] as { cap?: number }).cap, 1000);
  });

  test('"show more" stops being a live control once the cap is at the ceiling', async () => {
    renderReview();
    sendFromHost({
      t: 'fleet-diff',
      trees: [{
        root: '/repo', branch: 'main', sessions: ['s1'],
        base: { kind: 'head' }, omitted: 5000,
        files: [{ path: 'src/a.ts', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] }],
      }],
    } as never);

    // 500 -> 1000 -> 2000: the second press reaches MAX_FILE_CAP.
    await userEvent.click(screen.getByRole('button', { name: 'Show 5000 more' }));
    await userEvent.click(screen.getByRole('button', { name: 'Show 5000 more' }));

    const button = screen.getByRole('button', { name: /5000 more/ });
    assert.strictEqual(button.hasAttribute('disabled'), true);

    // A press on a disabled button posts nothing further — the cap the host
    // already saw (2000) is the last one sent.
    await userEvent.click(button);
    const raised = posted().filter((m) => m.t === 'request-fleet-diff' && m.cap !== undefined);
    assert.strictEqual(raised.length, 2);
    assert.strictEqual((raised[0] as { cap?: number }).cap, 1000);
    assert.strictEqual((raised[1] as { cap?: number }).cap, 2000);
  });
});
