import * as assert from 'node:assert';
import { posted, renderReview, resetHost, sendFromHost } from './review-harness';

const TREES = [{
  root: '/repo', branch: 'main', sessions: ['s1'],
  base: { kind: 'head' }, omitted: 0,
  files: [{ path: 'a.ts', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] }],
}];

const clock = async () => { await new Promise((r) => setTimeout(r, 900)); };

suite('review visibility', () => {
  setup(() => { resetHost(); });

  test('a hidden tab does not re-read the working trees', async () => {
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);
    sendFromHost({ t: 'review-visibility', visible: false } as never);
    resetHost();

    sendFromHost({ t: 'session-status', id: 's1', status: 'idle' } as never);
    await clock();

    assert.strictEqual(posted().some((m) => m.t === 'request-fleet-diff'), false);
  });

  test('becoming visible again reads once', async () => {
    renderReview();
    sendFromHost({ t: 'fleet-diff', trees: TREES } as never);
    sendFromHost({ t: 'review-visibility', visible: false } as never);
    sendFromHost({ t: 'session-status', id: 's1', status: 'idle' } as never);
    resetHost();

    sendFromHost({ t: 'review-visibility', visible: true } as never);
    await clock();

    assert.strictEqual(posted().filter((m) => m.t === 'request-fleet-diff').length, 1);
  });
});
