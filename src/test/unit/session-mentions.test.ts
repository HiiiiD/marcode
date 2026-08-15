import * as assert from 'assert';
import { sessionMentions } from '../../webview/lib/session-mentions';
import type { SessionSummary } from '../../protocol/messages';

function summary(id: string, title: string): SessionSummary {
  return {
    id, providerId: 'fake', model: 'm', title, cwd: '/w',
    status: 'idle', permissionMode: 'default', includeEditorContext: true,
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

suite('session mentions', () => {
  test('offers handoff first, then one row per kind per other session', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1');
    assert.strictEqual(rows[0].payload.kind, 'action');
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows.filter((r) =>
      r.payload.kind === 'session-ref' && r.payload.ref.sessionId === 's-2').length, 2);
  });

  test('omits the session doing the referencing', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'other')], 's-1');
    assert.strictEqual(rows.some((r) =>
      r.payload.kind === 'session-ref' && r.payload.ref.sessionId === 's-1'), false);
  });

  test('omits archived sessions', () => {
    const archived = { ...summary('s-2', 'gone'), archived: true };
    const rows = sessionMentions([summary('s-1', 'me'), archived], 's-1');
    assert.strictEqual(rows.length, 1);
  });

  test('carries the session title on the ref, for the transcript chip', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1');
    const ref = rows.find((r) => r.payload.kind === 'session-ref');
    assert.strictEqual(ref?.payload.kind === 'session-ref' && ref.payload.ref.title, 'refactor store');
  });

  test('slugs the title into the base token', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'Refactor Store!')], 's-1');
    const plan = rows.find((r) => r.baseToken.endsWith(':plan'));
    assert.strictEqual(plan?.baseToken, 'refactor-store:plan');
  });

  test('falls back to a stable slug for a title with no usable characters', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', '!!!')], 's-1');
    const plan = rows.find((r) => r.baseToken.endsWith(':plan'));
    assert.strictEqual(plan?.baseToken, 'session:plan');
  });
});
