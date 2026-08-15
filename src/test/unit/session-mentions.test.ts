import * as assert from 'assert';
import { sessionMentions, sessionRefsOf, type SessionMentionPayload } from '../../webview/lib/session-mentions';
import type { SessionSummary } from '../../protocol/messages';
import type { PendingMention } from '../../webview/lib/mention-menu';

function summary(id: string, title: string): SessionSummary {
  return {
    id, providerId: 'fake', model: 'm', title, cwd: '/w',
    status: 'idle', permissionMode: 'default', includeEditorContext: true,
    resumeTokens: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

suite('session mentions', () => {
  /**
   * One row, not one per `RefKind`. A session crossed with every kind put two
   * rows on screen reading the same title, told apart only by a hint in the
   * right margin — and half of them referenced a plan the session had never
   * produced, which the host could only reject at send time.
   */
  test('offers handoff first, then exactly one row per other session', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1', true);
    assert.strictEqual(rows[0].payload.kind, 'action');
    assert.strictEqual(rows[0].group, 'Actions');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows.filter((r) =>
      r.payload.kind === 'session-ref' && r.payload.ref.sessionId === 's-2').length, 1);
    const sessionRow = rows.find((r) => r.payload.kind === 'session-ref');
    assert.strictEqual(sessionRow?.group, 'Sessions');
  });

  test('references the last reply', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1', true);
    const ref = rows.find((r) => r.payload.kind === 'session-ref');
    assert.strictEqual(ref?.payload.kind === 'session-ref' && ref.payload.ref.kind, 'message');
  });

  test('omits the session doing the referencing', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'other')], 's-1', true);
    assert.strictEqual(rows.some((r) =>
      r.payload.kind === 'session-ref' && r.payload.ref.sessionId === 's-1'), false);
  });

  test('omits archived sessions', () => {
    const archived = { ...summary('s-2', 'gone'), archived: true };
    const rows = sessionMentions([summary('s-1', 'me'), archived], 's-1', true);
    assert.strictEqual(rows.length, 1);
  });

  test('carries the session title on the ref, for the transcript chip', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1', true);
    const ref = rows.find((r) => r.payload.kind === 'session-ref');
    assert.strictEqual(ref?.payload.kind === 'session-ref' && ref.payload.ref.title, 'refactor store');
  });

  test('slugs the title into the base token', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'Refactor Store!')], 's-1', true);
    const ref = rows.find((r) => r.payload.kind === 'session-ref');
    assert.strictEqual(ref?.baseToken, 'refactor-store');
  });

  test('falls back to a stable slug for a title with no usable characters', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', '!!!')], 's-1', true);
    const ref = rows.find((r) => r.payload.kind === 'session-ref');
    assert.strictEqual(ref?.baseToken, 'session');
  });

  /**
   * The handoff row opens a create dialog the composer only renders when the
   * catalog can answer for the source session's provider. Offered when it
   * cannot, picking it clears the typed query, closes the menu and does
   * nothing visible — so it is not offered.
   */
  test('omits handoff when there is nothing to hand off to', () => {
    const rows = sessionMentions(
      [summary('s-1', 'me'), summary('s-2', 'other')], 's-1', false,
    );
    assert.strictEqual(rows.some((r) => r.payload.kind === 'action'), false);
    assert.strictEqual(rows.length, 1);
  });

  test('disambiguates identically titled sessions in the visible label', () => {
    const rows = sessionMentions(
      [summary('s-1', 'me'), summary('s-abcd', 'Untitled'), summary('s-wxyz', 'Untitled')],
      's-1', true,
    );
    const labels = rows
      .filter((r) => r.payload.kind === 'session-ref')
      .map((r) => r.label);
    assert.strictEqual(new Set(labels).size, 2, 'the two sessions must read differently');
    assert.strictEqual(labels.every((l) => l.startsWith('Untitled (')), true);
    // The ref still carries the real title: it is what the transcript chip
    // and the composed block are keyed on.
    const ref = rows.find((r) => r.payload.kind === 'session-ref');
    assert.strictEqual(
      ref?.payload.kind === 'session-ref' && ref.payload.ref.title, 'Untitled',
    );
  });

  test('leaves a unique title alone', () => {
    const rows = sessionMentions(
      [summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1', true,
    );
    const ref = rows.find((r) => r.payload.kind === 'session-ref');
    assert.strictEqual(ref?.label, 'refactor store');
  });

  test('sessionRefsOf keeps only the session-ref payloads, in order', () => {
    const pending: PendingMention<SessionMentionPayload>[] = [
      { token: '@a:plan', payload: { kind: 'session-ref', ref: { sessionId: 's-2', kind: 'plan', title: 'a' } } },
      { token: '@handoff', payload: { kind: 'action', action: 'handoff' } },
      { token: '@b:message', payload: { kind: 'session-ref', ref: { sessionId: 's-3', kind: 'message', title: 'b' } } },
    ];
    const refs = sessionRefsOf(pending);
    assert.strictEqual(refs.length, 2);
    assert.strictEqual(refs[0].sessionId, 's-2');
    assert.strictEqual(refs[1].sessionId, 's-3');
  });
});
