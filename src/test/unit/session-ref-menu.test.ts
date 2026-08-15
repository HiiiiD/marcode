import * as assert from 'assert';
import {
  filterRefOptions, pruneRefs, refOptions, refQuery, spliceRef, tokenFor,
} from '../../webview/lib/session-ref-menu';
import type { SessionSummary } from '../../protocol/messages';

function summary(id: string, title: string): SessionSummary {
  return {
    id, providerId: 'fake', model: 'm', title, cwd: '/w',
    status: 'idle', permissionMode: 'default', includeEditorContext: true,
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false, createdAt: 1, updatedAt: 1,
  };
}

suite('session ref menu', () => {
  test('opens on @ at the start of the text', () => {
    assert.deepStrictEqual(refQuery('@', 1), { query: '', start: 0 });
  });

  test('opens on @ after a space, mid-prose', () => {
    assert.deepStrictEqual(refQuery('use @pla', 8), { query: 'pla', start: 4 });
  });

  test('does not open on an @ glued to a word', () => {
    assert.strictEqual(refQuery('me@example.com', 14), undefined);
  });

  test('closes once the query contains whitespace', () => {
    assert.strictEqual(refQuery('@plan now', 9), undefined);
  });

  test('ignores an @ that is after the caret', () => {
    assert.strictEqual(refQuery('hello @x', 5), undefined);
  });

  test('offers handoff plus one row per kind per other session', () => {
    const options = refOptions([summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1');
    assert.strictEqual(options[0].kind, 'handoff');
    assert.strictEqual(options.length, 3);
    assert.strictEqual(options.filter((o) => o.sessionId === 's-2').length, 2);
    assert.strictEqual(options.some((o) => o.sessionId === 's-1'), false);
  });

  test('omits archived sessions', () => {
    const archived = { ...summary('s-2', 'gone'), archived: true };
    const options = refOptions([summary('s-1', 'me'), archived], 's-1');
    assert.strictEqual(options.length, 1);
  });

  test('filters on label and kind', () => {
    const options = refOptions([summary('s-1', 'me'), summary('s-2', 'refactor store')], 's-1');
    assert.strictEqual(filterRefOptions(options, 'refac').length, 2);
    assert.strictEqual(filterRefOptions(options, 'hand').length, 1);
  });

  test('tokenFor slugs the label and disambiguates a collision', () => {
    const option = { id: 'x', label: 'Refactor Store', hint: '', kind: 'plan' as const, sessionId: 's-2' };
    assert.strictEqual(tokenFor(option, []), '@refactor-store:plan');
    assert.strictEqual(tokenFor(option, ['@refactor-store:plan']), '@refactor-store:plan-2');
  });

  test('spliceRef replaces the query span and leaves the caret after it', () => {
    const out = spliceRef('use @pla and go', 4, 8, '@refactor-store:plan');
    assert.strictEqual(out.text, 'use @refactor-store:plan and go');
    assert.strictEqual(out.caret, 24);
  });

  test('pruneRefs drops a ref whose token the user deleted', () => {
    const pending = [
      { token: '@a:plan', ref: { sessionId: 's-2', kind: 'plan' as const, title: 'a' } },
      { token: '@b:message', ref: { sessionId: 's-3', kind: 'message' as const, title: 'b' } },
    ];
    assert.strictEqual(pruneRefs('only @a:plan survives', pending).length, 1);
    assert.strictEqual(pruneRefs('neither', pending).length, 0);
  });
});
