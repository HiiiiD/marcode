// The review tab's own reducer slices not already covered by
// fleet-diff-reducer.test.ts (which exercises the sidebar's webview/reducer.ts).

import * as assert from 'assert';
import { initialReviewState, reduceReview } from '../../review/reducer';

suite('review reducer: branch-refs', () => {
  test('empty until something answers', () => {
    assert.deepStrictEqual(initialReviewState.branchRefs, {});
  });

  test('an answer is keyed by root, and does not disturb other roots', () => {
    const once = reduceReview(initialReviewState, {
      t: 'branch-refs', root: '/repo-a', refs: ['main', 'develop'],
    });
    const twice = reduceReview(once, {
      t: 'branch-refs', root: '/repo-b', refs: ['trunk'],
    });
    assert.deepStrictEqual(twice.branchRefs, {
      '/repo-a': ['main', 'develop'],
      '/repo-b': ['trunk'],
    });
  });

  test('a later answer for the same root replaces wholesale', () => {
    const once = reduceReview(initialReviewState, {
      t: 'branch-refs', root: '/repo', refs: ['main'],
    });
    const twice = reduceReview(once, {
      t: 'branch-refs', root: '/repo', refs: ['main', 'feature'],
    });
    assert.deepStrictEqual(twice.branchRefs['/repo'], ['main', 'feature']);
  });
});
