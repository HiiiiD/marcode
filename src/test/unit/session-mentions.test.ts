import * as assert from 'assert';
import { sessionMentions, type SessionMentionPayload } from '../../webview/lib/session-mentions';
import type { SessionSummary } from '../../protocol/messages';

function summary(id: string, title: string, name?: string): SessionSummary {
  return {
    id, providerId: 'fake', model: 'm', title, name: name ?? title, cwd: '/w',
    status: 'idle', permissionMode: 'default', includeEditorContext: true,
    resumeTokens: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

suite('session mentions', () => {
  test('offers handoff first, then exactly one row per other session', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1', true);
    assert.strictEqual(rows[0].payload.kind, 'action');
    assert.strictEqual(rows[0].group, 'Actions');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows.filter((r) => r.payload.kind === 'name' && r.id === 's-2').length, 1);
    const sessionRow = rows.find((r) => r.payload.kind === 'name');
    assert.strictEqual(sessionRow?.group, 'Sessions');
  });

  test('hints "last reply" for a session row', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1', true);
    const row = rows.find((r) => r.payload.kind === 'name');
    assert.strictEqual(row?.hint, 'last reply');
  });

  test('omits the session doing the referencing', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'other')], 's-1', true);
    assert.strictEqual(rows.some((r) => r.payload.kind === 'name' && r.id === 's-1'), false);
  });

  test('omits archived sessions', () => {
    const archived = { ...summary('s-2', 'gone'), archived: true };
    const rows = sessionMentions([summary('s-1', 'me'), archived], 's-1', true);
    assert.strictEqual(rows.length, 1);
  });

  test('slugs the title into the base token', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'Refactor Store!')], 's-1', true);
    const row = rows.find((r) => r.payload.kind === 'name');
    assert.strictEqual(row?.baseToken, 'refactor-store');
  });

  test('falls back to a stable slug for a title with no usable characters', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', '!!!')], 's-1', true);
    const row = rows.find((r) => r.payload.kind === 'name');
    assert.strictEqual(row?.baseToken, 'session');
  });

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
      .filter((r) => r.payload.kind === 'name')
      .map((r) => r.label);
    assert.strictEqual(new Set(labels).size, 2, 'the two sessions must read differently');
    assert.strictEqual(labels.every((l) => l.startsWith('Untitled (')), true);
  });

  test('leaves a unique title alone', () => {
    const rows = sessionMentions(
      [summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1', true,
    );
    const row = rows.find((r) => r.payload.kind === 'name');
    assert.strictEqual(row?.label, 'refactor store');
  });

  test('sessionMentions labels a renamed session by its name, not its title', () => {
    const sessions: SessionSummary[] = [
      summary('s1', 'Untitled', 'renamed-one'),
    ];
    const options = sessionMentions(sessions, 's-self', false);
    assert.strictEqual(options.find((o) => o.id === 's1')?.label, 'renamed-one');
  });

  test('sessionMentions still disambiguates two sessions sharing a default name', () => {
    const sessions: SessionSummary[] = [
      summary('s1', 'Untitled', 'claude-1'),
      summary('s2', 'Untitled', 'claude-1'),
    ];
    const options = sessionMentions(sessions, 's-self', false);
    assert.notStrictEqual(
      options.find((o) => o.id === 's1')?.label,
      options.find((o) => o.id === 's2')?.label,
    );
  });

  test('a session row carries no ref payload beyond its kind', () => {
    const rows = sessionMentions([summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1', true);
    const row = rows.find((r) => r.payload.kind === 'name');
    const payload: SessionMentionPayload | undefined = row?.payload;
    assert.deepStrictEqual(payload, { kind: 'name' });
  });
});
