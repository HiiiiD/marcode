import * as assert from 'node:assert';
import { screen } from '@testing-library/react';
import { posted, renderReview, resetHost, sendFromHost } from './review-harness';

suite('review app', () => {
  setup(() => { resetHost(); });

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
});
