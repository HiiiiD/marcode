import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import type { SessionState } from '../../protocol/messages';
import { initialReviewState, reduceReview } from '../../review/reducer';

const row = (id: string, remote = false): SessionState => ({
  id, providerId: 'claude', model: 'm', title: id, name: id, cwd: '/w', status: 'idle', permissionMode: 'default',
  includeEditorContext: false, resumeTokens: {}, createdAt: 1, updatedAt: 2,
  ...(remote ? { remote: { deviceId: 'd', deviceName: 'PC-desk', online: true, lastSeenAt: 1, relCwd: '.' } } : {}),
});

suite("other devices' sessions in the review tab", () => {
  test('the review tab keeps only this device\'s sessions', () => {
    const next = reduceReview(initialReviewState, { t: 'sessions-changed', sessions: [row('mine'), row('theirs', true)] });
    assert.deepStrictEqual(next.sessions.map((s) => s.id), ['mine']);
  });
});
