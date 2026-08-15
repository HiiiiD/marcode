import * as assert from 'assert';
import {
  filterMentions, pruneMentions, mentionQuery, sessionRefsOf, spliceMention, tokenFor,
  type MentionOption, type PendingMention,
} from '../../webview/lib/mention-menu';

function option(baseToken: string, label: string, group = 'Sessions'): MentionOption {
  return {
    id: baseToken, label, hint: '', group, baseToken,
    payload: { kind: 'session-ref', ref: { sessionId: 's-2', kind: 'plan', title: label } },
  };
}

suite('mention menu', () => {
  test('opens on @ at the start of the text', () => {
    assert.deepStrictEqual(mentionQuery('@', 1), { query: '', start: 0 });
  });

  test('opens on @ after a space, mid-prose', () => {
    assert.deepStrictEqual(mentionQuery('use @pla', 8), { query: 'pla', start: 4 });
  });

  test('does not open on an @ glued to a word', () => {
    assert.strictEqual(mentionQuery('me@example.com', 14), undefined);
  });

  test('closes once the query contains whitespace', () => {
    assert.strictEqual(mentionQuery('@plan now', 9), undefined);
  });

  test('ignores an @ that is after the caret', () => {
    assert.strictEqual(mentionQuery('hello @x', 5), undefined);
  });

  test('filters on label and base token, across any source', () => {
    const options = [
      option('refactor-store:plan', 'refactor store'),
      option('refactor-store:message', 'refactor store'),
      option('handoff', 'handoff', 'Actions'),
    ];
    assert.strictEqual(filterMentions(options, 'refac').length, 2);
    assert.strictEqual(filterMentions(options, 'hand').length, 1);
    // The base token is matchable, so a source that puts a path there is
    // searchable by path with no change here.
    assert.strictEqual(filterMentions(options, ':plan').length, 1);
    assert.strictEqual(filterMentions(options, '').length, 3);
  });

  test('tokenFor prefixes the base token and disambiguates a collision', () => {
    const o = option('refactor-store:plan', 'refactor store');
    assert.strictEqual(tokenFor(o, []), '@refactor-store:plan');
    assert.strictEqual(tokenFor(o, ['@refactor-store:plan']), '@refactor-store:plan-2');
    assert.strictEqual(
      tokenFor(o, ['@refactor-store:plan', '@refactor-store:plan-2']),
      '@refactor-store:plan-3',
    );
  });

  test('spliceMention replaces the query span and leaves the caret after it', () => {
    const out = spliceMention('use @pla and go', 4, 8, '@refactor-store:plan');
    assert.strictEqual(out.text, 'use @refactor-store:plan and go');
    assert.strictEqual(out.caret, 24);
  });

  test('pruneMentions drops a mention whose token the user deleted', () => {
    const pending: PendingMention[] = [
      { token: '@a:plan', payload: { kind: 'session-ref', ref: { sessionId: 's-2', kind: 'plan', title: 'a' } } },
      { token: '@b:message', payload: { kind: 'session-ref', ref: { sessionId: 's-3', kind: 'message', title: 'b' } } },
    ];
    assert.strictEqual(pruneMentions('only @a:plan survives', pending).length, 1);
    assert.strictEqual(pruneMentions('neither', pending).length, 0);
  });

  test('sessionRefsOf keeps only the session-ref payloads, in order', () => {
    const pending: PendingMention[] = [
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
