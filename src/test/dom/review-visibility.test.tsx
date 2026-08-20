import * as assert from 'node:assert';
import { waitFor } from '@testing-library/react';
import { posted, renderReview, resetHost, sendFromHost } from './review-harness';

const TREES = [{
  root: '/repo', branch: 'main', sessions: ['s1'],
  base: { kind: 'head' }, omitted: 0,
  files: [{ path: 'a.ts', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] }],
}];

// A small `reviewPollIntervalMs`, not the 750ms default: a fixed real-clock
// wait races the debounced `setTimeout` in `useFleetDiffRequests`, and the
// 900ms this used to wait left only ~150ms of margin over the default —
// thin enough for a loaded CI runner to eat. Shrinking the interval widens
// that margin (and the suite) without touching prod code.
const POLL_MS = 20;
const hydrateWithPoll = () => sendFromHost({
  t: 'hydrate', sessions: [], layout: { panes: [], orientation: 'horizontal' },
  reviewPollIntervalMs: POLL_MS,
} as never);

// Only for proving absence: a debounced request that never fires has no
// event to poll for, so this still has to wait out a real window. Bounded
// to a small multiple of POLL_MS instead of a large fixed constant.
const settle = async () => { await new Promise((r) => setTimeout(r, POLL_MS * 5)); };

suite('review visibility', () => {
  setup(() => { resetHost(); });

  test('a hidden tab does not re-read the working trees', async () => {
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);
    hydrateWithPoll();
    sendFromHost({ t: 'review-visibility', visible: false } as never);
    resetHost();

    sendFromHost({ t: 'session-status', id: 's1', status: 'idle' } as never);
    await settle();

    assert.strictEqual(posted().some((m) => m.t === 'request-fleet-diff'), false);
  });

  test('becoming visible again reads once', async () => {
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);
    hydrateWithPoll();
    sendFromHost({ t: 'review-visibility', visible: false } as never);
    sendFromHost({ t: 'session-status', id: 's1', status: 'idle' } as never);
    resetHost();

    sendFromHost({ t: 'review-visibility', visible: true } as never);

    await waitFor(() => {
      assert.strictEqual(posted().filter((m) => m.t === 'request-fleet-diff').length, 1);
    });
  });
});
